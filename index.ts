import * as PSK2 from 'ilp-protocol-psk2'
import * as Debug from 'debug'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import EventEmitter = require('eventemitter3')
import * as oer from 'oer-utils'
import * as Long from 'long'

const MAX_UINT64 = new BigNumber('18446744073709551615')

export interface PaymentSocketOpts {
  // TODO make sure this is a PluginV2
  plugin: any,
  destinationAccount: string,
  sharedSecret: Buffer,
  peerDestinationAccount?: string,
  peerSharedSecret?: Buffer,
  timeout?: number,
  sendAddressAndSecret?: boolean,
  enableRefunds?: boolean,
  identity?: string
}

export class PaymentSocket extends EventEmitter {
  public readonly destinationAccount: string
  public readonly sharedSecret: Buffer
  protected plugin: any
  protected peerDestinationAccount?: string
  protected peerSharedSecret?: Buffer
  protected peerWants: BigNumber
  protected peerExpects: BigNumber
  protected _balance: BigNumber
  protected _minBalance: BigNumber
  protected _maxBalance: BigNumber
  protected maxPaymentSize: BigNumber
  protected _totalSent: BigNumber
  protected _totalDelivered: BigNumber
  protected debug: Debug.IDebugger
  protected closed: boolean
  protected sending: boolean
  protected socketTimeout: number
  protected sendAddressAndSecret: boolean
  protected enableRefunds: boolean

  constructor (opts: PaymentSocketOpts) {
    super()
    this.debug = Debug(`ilp-protocol-paystream:PaymentSocket${opts.identity ? ':' + opts.identity : ''}`)

    this.plugin = opts.plugin
    this.destinationAccount = opts.destinationAccount
    this.sharedSecret = opts.sharedSecret
    this.peerDestinationAccount = opts.peerDestinationAccount
    this.peerSharedSecret = opts.peerSharedSecret
    this.socketTimeout = opts.timeout || 60000

    this._balance = new BigNumber(0)
    this._minBalance = new BigNumber(0)
    this._maxBalance = new BigNumber(Infinity)
    this.peerExpects = new BigNumber(0)
    this.peerWants = new BigNumber(Infinity)
    this.maxPaymentSize = new BigNumber(1000) // this will be adjusted as we send chunks
    this._totalSent = new BigNumber(0)
    this._totalDelivered = new BigNumber(0)
    this.closed = false
    this.sending = false
    this.sendAddressAndSecret = !!opts.sendAddressAndSecret
    this.enableRefunds = !!opts.enableRefunds
    this.debug(`new socket created with minBalance ${this._minBalance}, maxBalance ${this._maxBalance}, and refunds ${this.enableRefunds ? 'enabled' :  'disabled'}`)
  }

  get balance (): string {
    return this._balance.toString()
  }

  get minBalance (): string {
    return this._minBalance.toString()
  }

  get maxBalance (): string {
    return this._maxBalance.toString()
  }

  get totalSent (): string {
    return this._totalSent.toString()
  }

  get totalDelivered (): string {
    return this._totalDelivered.toString()
  }

  setMinBalance (amount: BigNumber.Value): void {
    if (this._maxBalance.isLessThan(amount)) {
      throw new Error(`Cannot set minBalance lower than maxBalance (${this._maxBalance})`)
    }
    this.debug(`setting minBalance to ${amount}`)
    this._minBalance = new BigNumber(amount)

    /* tslint:disable-next-line:no-floating-promises */
    this.maybeSend()
  }

  setMaxBalance (amount: BigNumber.Value): void {
    if (this._minBalance.isGreaterThan(amount)) {
      throw new Error(`Cannot set maxBalance lower than minBalance (${this._minBalance})`)
    }
    this.debug(`setting maxBalance to ${amount}`)
    this._maxBalance = new BigNumber(amount)

    /* tslint:disable-next-line:no-floating-promises */
    this.maybeSend()
  }

  setMinAndMaxBalance (amount: BigNumber.Value): void {
    this.debug(`setting minBalance and maxBalance to ${amount}`)
    this._minBalance = new BigNumber(amount)
    this._maxBalance = new BigNumber(amount)

    /* tslint:disable-next-line:no-floating-promises */
    this.maybeSend()
  }

  close () {
    this.debug(`closing payment socket with destinationAccount: ${this.destinationAccount}`)
    this.closed = true
    this.emit('close')
    this.removeAllListeners()
  }

  async handleRequest (request: PSK2.RequestHandlerParams): Promise<void> {
    if (this.closed) {
      this.debug('rejecting request because the socket is closed')
      return request.reject()
    }

    this.parseChunkData(request.data)

    const requestAmount = new BigNumber(request.amount.toString())

    if (requestAmount.isGreaterThan(0) && this._balance.isGreaterThanOrEqualTo(this._maxBalance)) {
      this.debug(`rejecting request because balance is already: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance})`)
      request.reject(serializeChunkData({
        amountExpected: this._minBalance.minus(this._balance),
        amountWanted: this._maxBalance.minus(this._balance)
        // don't include destinationAccount or sharedSecret because the other side already knows it
      }))
      return
    }

    // TODO should we reject requests with 0 amounts?

    // TODO make sure accept() call succeeds before increasing balance
    this._balance = this._balance.plus(requestAmount)
    const amountExpected = forceValueToBeBetween(this._minBalance.minus(this._balance), 0, MAX_UINT64)
    const amountWanted = forceValueToBeBetween(this._maxBalance.minus(this._balance), 0, MAX_UINT64)
    this.debug(`responding to peer telling them we expect: ${amountExpected} and want: ${amountWanted}`)
    request.accept(serializeChunkData({
      amountExpected,
      amountWanted
      // don't include destinationAccount or sharedSecret because the other side already knows it
    }))


    if (requestAmount.isGreaterThan(0)) {
      this.emit('chunk')
      this.emit('incoming_chunk', request.amount.toString())

      // If refunds are disabled, raise the minBalance automatically each time we receive money
      if (!this.enableRefunds && this._balance.isGreaterThan(this._minBalance)) {
        this.debug(`raising min balance from ${this._minBalance} to the current balance of ${this._balance} to prevent refund`)
        this._minBalance = this._balance
      }
    }

    this.debug(`accepted request with amount ${requestAmount}, balance is now: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance})`)
  }

  protected async maybeSend (): Promise<void> {
    let shouldContinue = true

    // Make sure we don't have two loops sending at the same time
    if (this.sending) {
      return
    }
    this.sending = true

    this.debug(`maybeSend - balance: ${this._balance}, minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance}, peerExpects: ${this.peerExpects}, peerWants: ${this.peerWants}`)

    // Wait until they've told us their address or close the socket if a timeout is reached
    if (!this.peerDestinationAccount || !this.peerSharedSecret) {
      this.debug('waiting for the other side to tell us their ILP address')
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), this.socketTimeout)

        const chunkListener = () => {
          if (this.peerDestinationAccount) {
            resolve()
            this.removeListener('chunk', chunkListener)
            clearTimeout(timeout)
          }
        }
        this.on('chunk', chunkListener)
      })
      if (!this.peerDestinationAccount || !this.peerSharedSecret) {
        this.debug('did not get destinationAccount from other side within timeout, closing socket')
        this.close()
        return
      }
    }

    // Determine if we're requesting money or pushing money
    // (A request for money is just a 0-amount packet that updates our min/max values)
    const amountExpected = this._minBalance.minus(this._balance)
    const amountWanted = this._maxBalance.minus(this._balance)
    let sourceAmount
    if (this._balance.isLessThan(this._minBalance)) {
      sourceAmount = new BigNumber(0)
      this.debug(`requesting ${amountExpected} from peer`)
      // Don't keep looping because we're just going to send one request for money and then wait to get paid
      shouldContinue = false
    } else if (this._balance.isGreaterThan(this._maxBalance) && this.peerWants.isGreaterThan(0)) {
      sourceAmount = this._balance.minus(this._maxBalance)
      sourceAmount = forceValueToBeBetween(sourceAmount, 0, this.maxPaymentSize)
      this.debug(`pushing ${sourceAmount} to peer`)
    } else if (this.peerExpects.isGreaterThan(0)) {
      // TODO adjust based on exchange rate and how much peer wants
      sourceAmount = BigNumber.min(this._balance.minus(this._minBalance), this.maxPaymentSize)
      sourceAmount = forceValueToBeBetween(sourceAmount, 0, this.maxPaymentSize)
      if (sourceAmount.isEqualTo(0)) {
        this.debug('peer requested money but we are already at our minimum balance')
        this.sending = false
        return
      }
      this.debug(`sending ${sourceAmount} because peer requested payment`)
    } else if (this.sendAddressAndSecret) {
      sourceAmount = new BigNumber(0)
      this.debug(`sending chunk of 0 just to tell the other party our address and secret`)
    } else {
      // TODO should we close the socket now?
      this.debug(`don't need to send or request money`)
      this.sending = false
      return
    }

    const chunkData: PaymentChunkData = {
      amountExpected: forceValueToBeBetween(amountExpected, 0, MAX_UINT64),
      amountWanted: forceValueToBeBetween(amountWanted, 0, MAX_UINT64)
    }
    this.debug(`telling peer we expect: ${chunkData.amountExpected} and want: ${chunkData.amountWanted}`)
    if (this.sendAddressAndSecret) {
      chunkData.destinationAccount = this.destinationAccount
      chunkData.sharedSecret = this.sharedSecret
      this.sendAddressAndSecret = false
    }

    // Send the chunk
    const result = await PSK2.sendRequest(this.plugin, {
      destinationAccount: this.peerDestinationAccount,
      sharedSecret: this.peerSharedSecret,
      sourceAmount: sourceAmount.toString(),
      data: serializeChunkData(chunkData)
      // TODO set minDestinationAmount based on exchange rate
    })

    this.parseChunkData(result.data)

    if (!PSK2.isPskError(result)) {
      this._totalSent = this._totalSent.plus(sourceAmount)
      this._totalDelivered = this._totalDelivered.plus(result.destinationAmount.toString())
      this._balance = this._balance.minus(sourceAmount)
      this.debug(`sent chunk of ${sourceAmount}, balance is now: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance}, peerExpects: ${this.peerExpects}, peerWants: ${this.peerWants})`)
      this.emit('outgoing_chunk', sourceAmount.toString())
      this.emit('chunk')

      // TODO determine exchange rate
      // TODO determine how much more the receiver is waiting for
    } else {
      // TODO handle errors
      this.debug(`sending chunk failed with code: ${result.code}`)
    }

    this.sending = false
    if (shouldContinue) {
      this.debug('going to try sending again')
      return this.maybeSend()
    }
  }

  protected parseChunkData (data: Buffer): void {
    if (data.length === 0) {
      this.debug('peer did not send any data in packet')
      return
    }

    try {
      const chunkData = deserializeChunkData(data)
      this.peerWants = chunkData.amountWanted
      this.peerExpects = chunkData.amountExpected
      this.peerDestinationAccount = chunkData.destinationAccount || this.peerDestinationAccount
      this.peerSharedSecret = chunkData.sharedSecret || this.peerSharedSecret
    } catch (err) {
      this.debug('unable to parse chunk data from peer:', err)
    }
  }
}

export interface ServerCreateSocketOpts {
  id?: Buffer,
  enableRefunds?: boolean
}

export class PaymentServer {
  protected receiver: PSK2.Receiver
  protected sockets: Map<string, PaymentSocket>
  protected debug: Debug.IDebugger
  protected plugin: any

  constructor (plugin: any, secret: Buffer) {
    this.debug = Debug('ilp-protocol-paystream:PaymentServer')
    this.plugin = plugin
    this.receiver = new PSK2.Receiver(plugin, secret)
    this.receiver.registerRequestHandler(this.handleRequest.bind(this))
    this.sockets = new Map()
  }

  async connect (): Promise<void> {
    await this.receiver.connect()
    this.debug('connected')
  }

  async disconnect (): Promise<void> {
    this.debug('disconnecting receiver and closing all sockets')
    await this.receiver.disconnect()
    for (let socket of this.sockets.values()) {
      socket.close()
    }
    this.debug('disconnected')
  }

  createSocket (opts?: ServerCreateSocketOpts): PaymentSocket {
    if (!opts) {
      opts = {}
    }

    const socketId = (opts.id || randomBytes(18)).toString('hex')
    if (opts.id && this.sockets.has(socketId)) {
      this.debug(`socket already exists with id:${socketId}`)
      return this.sockets.get(socketId)!
    }

    const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret(Buffer.from(socketId, 'hex'))
    const socket = new PaymentSocket({
      plugin: this.plugin,
      destinationAccount,
      sharedSecret,
      enableRefunds: opts.enableRefunds,
      identity: 'sever'
    })
    this.sockets.set(socketId, socket)
    this.debug(`created new socket with id: ${socketId}`)

    socket.once('close', () => { this.sockets.delete(socketId) })

    return socket
  }

  async handleRequest (request: PSK2.RequestHandlerParams): Promise<void> {
    if (!request.keyId) {
      this.debug('rejecting request because it does not have a keyId so it was not created by a PaymentServer')
      // TODO send a better error message so the sender knows what to do
      return request.reject()
    }

    const socket = this.sockets.get(request.keyId.toString('hex'))
    if (!socket) {
      this.debug(`rejecting request for keyId: ${request.keyId.toString('hex')} because there is no open socket with that ID`)
      // TODO send a better error message so the sender knows what to do
      return request.reject()
    }

    return socket.handleRequest(request)
  }
}

export interface CreateSocketOpts {
  plugin: any,
  destinationAccount: string,
  sharedSecret: Buffer,
  minBalance?: BigNumber.Value,
  maxBalance?: BigNumber.Value,
  enableRefunds?: boolean
}

export async function createSocket (opts: CreateSocketOpts) {
  const keyId = randomBytes(18)
  const debug = Debug('ilp-protocol-paystream:createSocket')
  let socket: PaymentSocket
  const receiver = await PSK2.createReceiver({
    plugin: opts.plugin,
    requestHandler: (request: PSK2.RequestHandlerParams) => {
      if (Buffer.isBuffer(request.keyId) && keyId.equals(request.keyId)) {
        return socket.handleRequest(request)
      }

      // TODO tell the other side why we're rejecting it
      debug(`rejecting request because keyId does not match socket. actual: ${request.keyId ? request.keyId.toString('hex') : 'undefined' }, expected: ${keyId.toString('hex')}`)
      return request.reject()
    }
  })
  const { destinationAccount, sharedSecret } = receiver.generateAddressAndSecret(keyId)
  socket = new PaymentSocket({
    plugin: opts.plugin,
    destinationAccount,
    sharedSecret,
    peerDestinationAccount: opts.destinationAccount,
    peerSharedSecret: opts.sharedSecret,
    sendAddressAndSecret: true,
    enableRefunds: opts.enableRefunds,
    identity: 'client'
  })
  if (opts.minBalance !== undefined) {
    socket.setMinBalance(opts.minBalance)
  }
  if (opts.maxBalance !== undefined) {
    socket.setMaxBalance(opts.maxBalance)
  }

  /* tslint:disable-next-line:no-floating-promises */
  socket.once('close', () => receiver.disconnect())

  return socket
}

interface PaymentChunkData {
  // TODO do we need to send all of these numbers?
  amountExpected: BigNumber,
  amountWanted: BigNumber,
  destinationAccount?: string,
  sharedSecret?: Buffer
}

function forceValueToBeBetween (value: BigNumber.Value, min: BigNumber.Value, max: BigNumber.Value): BigNumber {
  return BigNumber.min(BigNumber.max(value, min), max)
}

function serializeChunkData (chunkData: PaymentChunkData): Buffer {
  const amountExpected = forceValueToBeBetween(chunkData.amountExpected, 0, MAX_UINT64)
  const amountWanted = forceValueToBeBetween(chunkData.amountWanted, 0, MAX_UINT64)

  const writer = new oer.Writer()
  writer.writeUInt64(bigNumberToHighLow(amountExpected))
  writer.writeUInt64(bigNumberToHighLow(amountWanted))
  writer.writeVarOctetString(Buffer.from(chunkData.destinationAccount || '', 'utf8'))
  writer.writeVarOctetString(chunkData.sharedSecret || Buffer.alloc(0))
  return writer.getBuffer()
}

function deserializeChunkData (buffer: Buffer): PaymentChunkData {
  const reader = oer.Reader.from(buffer)
  const amountExpected = highLowToBigNumber(reader.readUInt64())
  const amountWanted = highLowToBigNumber(reader.readUInt64())
  let destinationAccount: string | undefined = reader.readVarOctetString().toString('utf8')
  if (destinationAccount === '') {
    destinationAccount = undefined
  }
  let sharedSecret: Buffer | undefined = reader.readVarOctetString()
  if (sharedSecret.length === 0) {
    sharedSecret = undefined
  }

  return {
    amountExpected,
    amountWanted,
    destinationAccount,
    sharedSecret
  }
}

// oer-utils returns [high, low], whereas Long expects low first
function highLowToBigNumber (highLow: number[]): BigNumber {
  // TODO use a more efficient method to convert this
  const long = Long.fromBits(highLow[1], highLow[0], true)
  return new BigNumber(long.toString(10))
}

function bigNumberToHighLow (bignum: BigNumber): number[] {
  const long = Long.fromString(bignum.toString(10), true)
  return [long.getHighBitsUnsigned(), long.getLowBitsUnsigned()]
}
