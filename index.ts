import * as PSK2 from 'ilp-protocol-psk2'
import * as Debug from 'debug'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import EventEmitter = require('eventemitter3')
import * as oer from 'oer-utils'
import * as Long from 'long'

const MAX_UINT64 = new BigNumber('18446744073709551615')

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

  constructor (plugin: any, destinationAccount: string, sharedSecret: Buffer, peerDestinationAccount?: string, peerSharedSecret?: Buffer) {
    super()
    this.debug = Debug('ilp-protocol-paystream:PaymentSocket')
    this.plugin = plugin
    this.destinationAccount = destinationAccount
    this.sharedSecret = sharedSecret
    this.peerDestinationAccount = peerDestinationAccount
    this.peerSharedSecret = peerSharedSecret
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
    // TODO make this configurable
    this.socketTimeout = 60000
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
  }

  async handleRequest (request: PSK2.RequestHandlerParams): Promise<void> {
    if (this.closed) {
      this.debug('rejecting request because the socket is closed')
      return request.reject()
    }

    this.parseChunkData(request.data)

    if (request.amount.toString() !== '0' && this._balance.isGreaterThanOrEqualTo(this._maxBalance)) {
      this.debug(`rejecting request because balance is already: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance})`)
      request.reject(serializeChunkData({
        amountExpected: this._minBalance.minus(this._balance),
        amountWanted: this._maxBalance.minus(this._balance)
        // don't include destinationAccount or sharedSecret because the other side already knows it
      }))
      return
    }

    // TODO make sure accept() call succeeds before increasing balance
    this._balance = this._balance.plus(request.amount.toString(10))
    request.accept(serializeChunkData({
      amountExpected: this._minBalance.minus(this._balance),
      amountWanted: this._maxBalance.minus(this._balance)
      // don't include destinationAccount or sharedSecret because the other side already knows it
    }))
    this.emit('chunk')
    this.emit('incoming_chunk', request.amount.toString())
    this.debug(`accepted request, balance is now: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance})`)

    /* tslint:disable-next-line:no-floating-promises */
    this.maybeSend()
  }

  protected async maybeSend (): Promise<void> {
    let shouldContinue = true

    // Make sure we don't have two loops sending at the same time
    if (this.sending) {
      return
    }
    this.sending = true

    this.debug(`maybeSend - balance: ${this._balance}, minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance}, peerExpects: ${this.peerExpects}, peerWants: ${this.peerWants}`)

    if (!this.peerDestinationAccount || !this.peerSharedSecret) {
      this.debug('waiting for the other side to tell us their ILP address')
      // TODO check this if we get an incoming chunk before the timeout
      setTimeout(() => {
        if (!this.peerDestinationAccount) {
          this.debug('did not get destinationAccount from other side within timeout, closing socket')
          this.close()
        }
      }, this.socketTimeout)
      this.sending = false
      return
    }

    // Determine if we're requesting money or pushing money
    let sourceAmount
    let amountExpected
    let amountWanted
    if (this._balance.isLessThan(this._minBalance)) {
      sourceAmount = new BigNumber(0)
      amountExpected = this._minBalance.minus(this._balance)
      amountWanted = this._maxBalance.minus(this._balance)
      this.debug(`requesting ${amountExpected} from peer`)
      // Don't keep looping because we're just going to send one request for money and then wait to get paid
      shouldContinue = false
    } else if (this._balance.isGreaterThan(this._maxBalance)) {
      sourceAmount = BigNumber.min(this._balance.minus(this._maxBalance), this.maxPaymentSize)
      amountExpected = new BigNumber(0)
      amountWanted = this._maxBalance.minus(this._balance)
      this.debug(`pushing ${sourceAmount} to peer`)
    } else if (this.peerExpects.isGreaterThan(0)) {
      // TODO adjust based on exchange rate and how much peer wants
      sourceAmount = new BigNumber(1000)
      amountExpected = new BigNumber(0)
      amountWanted = this._maxBalance.minus(this._balance)
      this.debug(`sending ${sourceAmount} because peer requested payment`)
    } else {
      // TODO should we close the socket now?
      this.debug(`don't need to send or request money`)
      this.sending = false
      return
    }

    if (sourceAmount.isGreaterThan(this.maxPaymentSize)) {
      sourceAmount = this.maxPaymentSize
    }
    if (sourceAmount.isGreaterThan(MAX_UINT64)) {
      sourceAmount = MAX_UINT64
    }
    if (sourceAmount.isLessThan(0)) {
      sourceAmount = new BigNumber(0)
    }

    const result = await PSK2.sendRequest(this.plugin, {
      destinationAccount: this.peerDestinationAccount,
      sharedSecret: this.peerSharedSecret,
      sourceAmount: sourceAmount.toString(),
      data: serializeChunkData({
        amountExpected,
        amountWanted,
        // TODO only send the destinationAccount and sharedSecret once
        destinationAccount: this.destinationAccount,
        sharedSecret: this.sharedSecret
      })
    })

    this.parseChunkData(result.data)

    if (!PSK2.isPskError(result)) {
      this._totalSent = this._totalSent.plus(sourceAmount)
      this._totalDelivered = this._totalDelivered.plus(result.destinationAmount.toString())
      this._balance = this._balance.minus(sourceAmount)
      this.debug(`sent chunk, balance is now: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance})`)
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
    await this.receiver.disconnect()
    this.debug('disconnected')
  }

  createSocket (keyId?: Buffer): PaymentSocket {
    const socketId = (keyId || randomBytes(18)).toString('hex')
    if (keyId && this.sockets.has(socketId)) {
      this.debug(`socket already exists with id:${socketId}`)
      return this.sockets.get(socketId)!
    }

    const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret(Buffer.from(socketId, 'hex'))
    const socket = new PaymentSocket(this.plugin, destinationAccount, sharedSecret)
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
  maxBalance?: BigNumber.Value
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
  socket = new PaymentSocket(opts.plugin, destinationAccount, sharedSecret, opts.destinationAccount, opts.sharedSecret)
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

function serializeChunkData (chunkData: PaymentChunkData): Buffer {
  const amountExpected = BigNumber.min(BigNumber.max(0, chunkData.amountExpected), MAX_UINT64)
  const amountWanted = BigNumber.min(BigNumber.max(0, chunkData.amountWanted), MAX_UINT64)

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
