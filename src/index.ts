import * as PSK2 from 'ilp-protocol-psk2'
import * as Debug from 'debug'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import EventEmitter = require('eventemitter3')
import * as oer from 'oer-utils'
import * as Long from 'long'

const MAX_UINT64 = new BigNumber('18446744073709551615')
const DEFAULT_STABILIZED_TIMEOUT = 60000
const PROBE_AMOUNT = 1000
const STARTING_RETRY_TIMEOUT = 100
const RETRY_TIMEOUT_INCREASE_FACTOR = 2

export interface PaymentSocketOpts {
  // TODO make sure this is a PluginV2
  plugin: any,
  destinationAccount: string,
  sharedSecret: Buffer,
  peerDestinationAccount?: string,
  timeout?: number,
  sendAddress?: boolean,
  enableRefunds?: boolean,
  identity?: string,
  slippage?: BigNumber,
  maxRetries?: number
}

export class PaymentSocket extends EventEmitter {
  protected _destinationAccount: string
  protected _sharedSecret: Buffer
  protected plugin: any
  protected peerDestinationAccount?: string
  protected peerWants: BigNumber
  protected peerExpects: BigNumber
  protected _balance: BigNumber
  protected _minBalance: BigNumber
  protected _maxBalance: BigNumber
  protected maxPaymentSize: BigNumber
  protected _totalSent: BigNumber
  protected _totalDelivered: BigNumber
  protected _exchangeRate: BigNumber
  protected debug: Debug.IDebugger
  protected closed: boolean
  protected sending: boolean
  protected socketTimeout: number
  protected sendAddress: boolean
  protected enableRefunds: boolean
  protected slippage: BigNumber
  protected connected: boolean
  protected consecutiveRejectedRequests: number
  protected maxRetries: number
  protected retryTimeout: number
  // TODO expose the number of chunks sent/received or fulfilled/rejected?

  constructor (opts: PaymentSocketOpts) {
    super()
    // TODO maybe these statements should have an ID that matches the destinationAccount and keyId seen in the logs from other modules
    this.debug = Debug(`ilp-protocol-paystream:PaymentSocket${opts.identity ? ':' + opts.identity : ''}`)

    this.plugin = opts.plugin
    this._destinationAccount = opts.destinationAccount
    this._sharedSecret = opts.sharedSecret
    this.peerDestinationAccount = opts.peerDestinationAccount
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
    this.sendAddress = !!opts.sendAddress
    this.enableRefunds = !!opts.enableRefunds
    this.slippage = opts.slippage || new BigNumber(0.01)
    this.connected = false
    this.consecutiveRejectedRequests = 0
    this.maxRetries = (typeof opts.maxRetries === 'number' ? opts.maxRetries : 5)
    this.retryTimeout = STARTING_RETRY_TIMEOUT
    this.debug(`new socket created with minBalance ${this._minBalance}, maxBalance ${this._maxBalance}, slippage: ${this.slippage}, and refunds ${this.enableRefunds ? 'enabled' : 'disabled'}`)
  }

  get destinationAccount (): string {
    return this._destinationAccount
  }

  get sharedSecret (): Buffer {
    return this._sharedSecret
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

  get exchangeRate (): string {
    if (!this.connected) {
      throw new Error('Must be connected to get exchangeRate')
    }

    // This is the real rate that we've been delivering money based on,
    // which should be no worse than the exchange rate we first saw less the configured slippage
    if (this._totalDelivered.isGreaterThan(0)) {
      return this._totalDelivered.dividedBy(this._totalSent).toString()
    } else {
      return this._exchangeRate.toString()
    }
  }

  isConnected (): boolean {
    return this.connected
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

  async connect (timeout = DEFAULT_STABILIZED_TIMEOUT): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Socket is already closed'))
    }

    if (this.connected) {
      return Promise.resolve()
    }

    /* tslint:disable-next-line:no-floating-promises */
    this.maybeSend()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup.call(this)
        reject(new Error('Connect timed out'))
      }, timeout)
      const errorListener = (err: Error) => {
        cleanup.call(this)
        reject(err)
      }
      const connectListener = () => {
        cleanup.call(this)
        resolve()
      }

      function cleanup () {
        clearTimeout(timer)
        this.removeListener('error', errorListener)
        this.removeListener('connect', connectListener)
      }

      this.once('error', errorListener)
      this.once('connect', connectListener)
      /* tslint:disable-next-line:no-unnecessary-type-assertion */
    }) as Promise<void>
  }

  close () {
    this.debug(`closing payment socket with destinationAccount: ${this._destinationAccount}`)
    this.closed = true
    this.connected = false
    this.emit('close')
  }

  async stabilized (timeout = DEFAULT_STABILIZED_TIMEOUT): Promise<void> {
    if (this.isStabilized()) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup.call(this)
        reject(new Error('Timed out without stabilizing'))
      }, timeout)
      const errorListener = (err: Error) => {
        cleanup.call(this)
        reject(err)
      }
      const stabilizedListener = () => {
        cleanup.call(this)
        if (!this.isStabilized()) {
          reject(new Error(`Stopped outside of the balance window. Current balance is: ${this._balance}, minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance}`))
        } else {
          resolve()
        }
      }

      function cleanup () {
        clearTimeout(timer)
        this.removeListener('error', errorListener)
        this.removeListener('stabilized', stabilizedListener)
      }

      this.once('error', errorListener)
      this.once('stabilized', stabilizedListener)
      /* tslint:disable-next-line:no-unnecessary-type-assertion */
    }) as Promise<void>
  }

  isStabilized (): boolean {
    return !this.sending
      && this._balance.isLessThanOrEqualTo(this._maxBalance)
      && this._balance.isGreaterThanOrEqualTo(this._minBalance)
      && (this.peerExpects.isEqualTo(0) || this._balance.isEqualTo(this._minBalance))
  }

  async handleRequest (request: PSK2.RequestHandlerParams): Promise<void> {
    if (this.closed) {
      this.debug('rejecting request because the socket is closed')
      return request.reject()
    }

    this.parseChunkData(request.data)

    const requestAmount = new BigNumber(request.amount.toString())

    if (!request.isFulfillable) {
      // TODO disconnect if we get too many of these
      this.debug(`got unfulfillable request`)
      return request.reject(serializeChunkData({
        amountExpected: this._minBalance.minus(this._balance),
        amountWanted: this._maxBalance.minus(this._balance)
        // don't include destinationAccount or sharedSecret because the other side already knows it
      }))
    }

    // We've requested more money than the other side's minBalance allows them to send
    if (requestAmount.isEqualTo(0) && this._balance.isLessThan(this._minBalance)) {
      this.debug(`requested money from other party but they aren't sending it. current balance: ${this._balance}, minBalance: ${this._minBalance}`)
      // TODO is this always an error? What if we changed the limit between now and when the other side sent this request?
      this.emit('error', new Error(`Requested money from other party but they aren't sending it. Current balance: ${this._balance}, expected: ${this._minBalance}`))
    }

    // The other side has exceeded our maxBalance
    if (requestAmount.isGreaterThan(0) && this._balance.isGreaterThanOrEqualTo(this._maxBalance)) {
      this.debug(`rejecting request because balance is already: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance})`)
      return request.reject(serializeChunkData({
        amountExpected: this._minBalance.minus(this._balance),
        amountWanted: this._maxBalance.minus(this._balance)
        // don't include destinationAccount or sharedSecret because the other side already knows it
      }))
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

    this.debug(`accepted request with amount ${requestAmount}, balance is now: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance}, peerExpects: ${this.peerExpects}, peerWants: ${this.peerWants})`)

    if (this.peerExpects.isGreaterThan(0) && this._balance.isGreaterThan(this._minBalance)) {
      return this.maybeSend()
    }

    // Check if the socket has stabilized (both sides are satisfied)
    if (this.isStabilized()) {
      this.debug('socket stabilized')
      this.emit('stabilized')
    }
  }

  protected async maybeSend (forceSend = false): Promise<void> {
    // Start on the next tick of the event loop
    // This ensures that if someone calls "await socket.stabilized" right after changing the limit
    // the "stabilized" event will fire _after_ the listener has been added
    await Promise.resolve()

    let shouldContinue = true

    // Make sure we don't have two loops sending at the same time
    if (this.sending) {
      this.debug('already in the process of sending, not starting another send loop')
      return
    }
    this.sending = true

    this.debug(`maybeSend - balance: ${this._balance}, minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance}, peerExpects: ${this.peerExpects}, peerWants: ${this.peerWants}`)

    // Wait until they've told us their address or close the socket if a timeout is reached
    if (!this.peerDestinationAccount) {
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
      if (!this.peerDestinationAccount) {
        this.debug('did not get destinationAccount from other side within timeout, closing socket')
        this.emit('error', new Error('Did not get destinationAccount from other party within timeout'))
        this.close()
        return
      }
    }

    // Determine if we're requesting money or pushing money
    // (A request for money is just a 0-amount packet that updates our min/max values)
    const amountExpected = this._minBalance.minus(this._balance)
    const amountWanted = this._maxBalance.minus(this._balance)
    let unfulfillableCondition: Buffer | undefined = undefined
    let sourceAmount
    if (this._balance.isLessThan(this._minBalance)) {
      // Request payment
      sourceAmount = new BigNumber(0)
      this.debug(`requesting ${amountExpected} from peer`)
      // Don't keep looping because we're just going to send one request for money and then wait to get paid
      shouldContinue = false
    } else if (this._balance.isGreaterThan(this._maxBalance) && this.peerWants.isGreaterThan(0)) {
      // Send payment (because our balance is too high)
      sourceAmount = this._balance.minus(this._maxBalance)
      sourceAmount = forceValueToBeBetween(sourceAmount, 0, this.maxPaymentSize)

      // Adjust how much we're sending to the receiver's maximum
      if (this._exchangeRate) {
        const sourceAmountReceiverWants = this.peerWants.dividedBy(this._exchangeRate).decimalPlaces(0, BigNumber.ROUND_CEIL)
        sourceAmount = BigNumber.min(sourceAmount, sourceAmountReceiverWants)
      }
      this.debug(`pushing ${sourceAmount} to peer`)
    } else if (this.peerExpects.isGreaterThan(0)) {
      // Peer is requesting payment, so pay until we've reached our minBalance
      // TODO adjust based on exchange rate and how much peer wants
      sourceAmount = BigNumber.min(this._balance.minus(this._minBalance), this.maxPaymentSize)
      sourceAmount = forceValueToBeBetween(sourceAmount, 0, this.maxPaymentSize)

      // Adjust how much we're sendign to the receiver's minimum
      if (this._exchangeRate) {
        const sourceAmountReceiverExpects = this.peerExpects.dividedBy(this._exchangeRate).decimalPlaces(0, BigNumber.ROUND_CEIL)
        sourceAmount = BigNumber.min(sourceAmount, sourceAmountReceiverExpects)
      }

      if (sourceAmount.isEqualTo(0)) {
        this.debug('peer requested money but we are already at our minimum balance')
        shouldContinue = false
      }
      this.debug(`sending ${sourceAmount} because peer requested payment`)
    } else if (this.sendAddress || !this._exchangeRate) {
      // Send a dummy request just to tell the other side our details and determine the exchange rate
      // TODO the initialization call should just be separate from this flow
      sourceAmount = new BigNumber(PROBE_AMOUNT)
      unfulfillableCondition = randomBytes(32)
      this.debug(`sending unfulfillable request just to tell the other party our address and to determine the exchange rate`)
    } else {
      // Both sides are satisfied (for now)
      // TODO should we close the socket now?
      this.debug(`don't need to send or request money`)
      this.sending = false
      this.emit('stabilized')
      this.debug('socket stabilized')
      return
    }

    const chunkData: PaymentChunkData = {
      amountExpected: forceValueToBeBetween(amountExpected, 0, MAX_UINT64),
      amountWanted: forceValueToBeBetween(amountWanted, 0, MAX_UINT64)
    }
    this.debug(`telling peer we expect: ${chunkData.amountExpected} and want: ${chunkData.amountWanted}`)
    if (this.sendAddress) {
      chunkData.destinationAccount = this._destinationAccount
      this.sendAddress = false
    }

    // Use the exchange rate to determine the minDestinationAmount the receiver should accept for this chunk
    let minDestinationAmount
    if (this._exchangeRate) {
      minDestinationAmount = sourceAmount
        .times(this._exchangeRate)
        .times(new BigNumber(1).minus(this.slippage))
        .decimalPlaces(0, BigNumber.ROUND_FLOOR)
      minDestinationAmount = forceValueToBeBetween(minDestinationAmount, 0, MAX_UINT64)
      this.debug(`setting minDestinationAmount to ${minDestinationAmount}, based on an exchange rate of ${this._exchangeRate} and slippage of ${this.slippage.times(100)}%`)
    } else if (unfulfillableCondition) {
      minDestinationAmount = MAX_UINT64
    } else {
      minDestinationAmount = new BigNumber(0)
    }

    // Send the chunk
    const result = await PSK2.sendRequest(this.plugin, {
      destinationAccount: this.peerDestinationAccount,
      sharedSecret: this._sharedSecret,
      sourceAmount: sourceAmount.toString(),
      data: serializeChunkData(chunkData),
      unfulfillableCondition,
      minDestinationAmount: minDestinationAmount.toString()
      // TODO set minDestinationAmount based on exchange rate
    })
    // we need to convert to string just because the BigNumber version used by PSK2 right now is incompatible with the one this module uses :/
    const destinationAmount = new BigNumber(result.destinationAmount.toString(10))

    this.parseChunkData(result.data)

    // Determine exchange rate
    // Right now this will only be done on the first chunk and won't change from there
    // TODO should the exchange rate be allowed to change with each chunk?
    // (we need to make sure connectors can't just make each chunk progressively worse by the slippage amount)
    if (!this._exchangeRate && destinationAmount.isGreaterThan(0)) {
      this._exchangeRate = destinationAmount.dividedBy(sourceAmount)
      this.debug(`determined exchange rate to be: ${this._exchangeRate}`)

      // Emit the connect event now because getting the exchange rate is the first thing we'll do
      this.connected = true
      this.emit('connect')
    }

    // Handle fulfillment or specific types of rejections
    if (!PSK2.isPskError(result)) {
      // Request was fulfilled

      this._totalSent = this._totalSent.plus(sourceAmount)
      this._totalDelivered = this._totalDelivered.plus(destinationAmount)
      this._balance = this._balance.minus(sourceAmount)
      this.debug(`sent chunk of ${sourceAmount}, balance is now: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance}, peerExpects: ${this.peerExpects}, peerWants: ${this.peerWants})`)
      this.emit('outgoing_chunk', sourceAmount.toString())
      this.emit('chunk')

      // This request succeeded to reset our retry-related variables
      this.consecutiveRejectedRequests = 0
      this.retryTimeout = STARTING_RETRY_TIMEOUT
    } else if (unfulfillableCondition) {
      // We sent an unfulfillable test payment so of course it was rejected

      this.debug(`request was rejected because it was unfulfillable`)
    } else if (destinationAmount.isGreaterThan(0) && minDestinationAmount.isGreaterThan(result.destinationAmount.toString(10))) {
      // Receiver rejected because too little arrived

      this.debug(`receiver rejected packet because too little arrived. actual destination amount: ${result.destinationAmount}, expected: ${minDestinationAmount} (sourceAmount: ${sourceAmount}, expected exchange rate: ${this._exchangeRate})`)
      this.emit('error', new Error(`Exchange rate changed too much, not sending any more. Actual rate: ${destinationAmount.dividedBy(sourceAmount)}, expected: ${this._exchangeRate}`))

      shouldContinue = false
      this.consecutiveRejectedRequests += 1
    } else if (result.code[0].toUpperCase() === 'T') {
      // Retry on temporary rejection codes

      this.consecutiveRejectedRequests += 1
      if (this.consecutiveRejectedRequests < this.maxRetries) {
        this.debug(`got temporary error code: ${result.code}, message: ${result.message}. waiting ${this.retryTimeout}ms before retrying`)
        await new Promise((resolve, reject) => setTimeout(resolve, this.retryTimeout))
        this.retryTimeout = this.retryTimeout * RETRY_TIMEOUT_INCREASE_FACTOR
      } else {
        this.debug(`packet was rejected ${this.consecutiveRejectedRequests} times in a row, not retrying anymore`)
        this.emit('error', new Error(`Sending chunk failed with code: ${result.code} and message: ${result.message}. Retried ${this.consecutiveRejectedRequests} times but each was rejected`))
        shouldContinue = false
      }
    } else {
      // Unexpected error

      this.debug(`sending chunk failed with code: ${result.code} and message: ${result.message}`)
      this.emit('error', new Error(`Sending chunk failed with code: ${result.code} and message: ${result.message}`))
      this.consecutiveRejectedRequests += 1
      shouldContinue = false
    }

    this.sending = false
    if (shouldContinue) {
      this.debug('going to try sending again')
      return this.maybeSend()
    } else if (this.isStabilized()) {
      this.emit('stabilized')
      this.debug('socket stabilized')
    } else {
      this.debug('socket is not yet stabilized, but not continuing to send')
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
    } catch (err) {
      this.debug('unable to parse chunk data from peer:', err)
    }
  }
}

export interface ServerCreateSocketOpts {
  enableRefunds?: boolean,
  slippage?: BigNumber.Value,
  maxRetries?: number
}

export interface PaymentServerOpts {
  plugin: any,
  secret?: Buffer
}

export class PaymentServer {
  protected receiver: PSK2.Receiver
  protected sockets: Map<string, PaymentSocket>
  protected debug: Debug.IDebugger
  protected plugin: any

  constructor (opts: PaymentServerOpts) {
    this.debug = Debug('ilp-protocol-paystream:PaymentServer')
    this.plugin = opts.plugin
    const secret = opts.secret || randomBytes(32)
    this.receiver = new PSK2.Receiver(this.plugin, secret)
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

  // TODO should this be async and return an already connected socket?
  createSocket (opts?: ServerCreateSocketOpts): PaymentSocket {
    if (!opts) {
      opts = {}
    }

    const socketId = randomBytes(18)
    const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret(socketId)
    const socket = new PaymentSocket({
      ...opts,
      plugin: this.plugin,
      destinationAccount,
      sharedSecret,
      identity: 'sever',
      slippage: (opts.slippage !== undefined ? new BigNumber(opts.slippage) : undefined)
    })
    this.sockets.set(socketId.toString('hex'), socket)
    this.debug(`created new socket with id: ${socketId.toString('hex')}`)

    socket.once('close', () => { this.sockets.delete(socketId.toString('hex')) })

    return socket
  }

  async handleRequest (request: PSK2.RequestHandlerParams): Promise<void> {
    if (!request.keyId) {
      this.debug('rejecting request because it does not have a keyId so it was not created by a PaymentServer')
      // TODO send a better error message so the sender knows exactly what's going on
      return request.reject(serializeChunkData({
        amountWanted: new BigNumber(0),
        amountExpected: new BigNumber(0)
      }))
    }

    const socket = this.sockets.get(request.keyId.toString('hex'))
    if (!socket) {
      this.debug(`rejecting request for keyId: ${request.keyId.toString('hex')} because there is no open socket with that ID`)
      // TODO send a better error message so the sender knows exactly what's going on
      return request.reject(serializeChunkData({
        amountWanted: new BigNumber(0),
        amountExpected: new BigNumber(0)
      }))
    }

    return socket.handleRequest(request)
  }
}

export async function createServer (opts: PaymentServerOpts): Promise<PaymentServer> {
  const server = new PaymentServer(opts)
  await server.connect()
  return server
}

export interface CreateSocketOpts {
  plugin: any,
  destinationAccount: string,
  sharedSecret: Buffer,
  minBalance?: BigNumber.Value,
  maxBalance?: BigNumber.Value,
  enableRefunds?: boolean,
  slippage?: BigNumber.Value,
  maxRetries?: number
}

export async function createSocket (opts: CreateSocketOpts) {
  const debug = Debug('ilp-protocol-paystream:createSocket')
  let socket: PaymentSocket
  const receiver = await PSK2.createReceiver({
    plugin: opts.plugin
  })
  const { destinationAccount } = receiver.registerRequestHandlerForSecret(opts.sharedSecret, (request: PSK2.RequestHandlerParams) => {
    return socket.handleRequest(request)
  })
  socket = new PaymentSocket({
    plugin: opts.plugin,
    destinationAccount,
    sharedSecret: opts.sharedSecret,
    peerDestinationAccount: opts.destinationAccount,
    sendAddress: true,
    enableRefunds: opts.enableRefunds,
    identity: 'client',
    slippage: (opts.slippage !== undefined ? new BigNumber(opts.slippage) : undefined),
    maxRetries: opts.maxRetries
  })
  if (opts.minBalance !== undefined) {
    socket.setMinBalance(opts.minBalance)
  } else {
    debug(`using default minBalance of ${socket.minBalance}`)
  }
  if (opts.maxBalance !== undefined) {
    socket.setMaxBalance(opts.maxBalance)
  } else {
    debug(`using default maxBalance of ${socket.maxBalance}`)
  }

  /* tslint:disable-next-line:no-floating-promises */
  socket.once('close', () => receiver.disconnect())

  // TODO should we let the user call connect instead?
  await socket.connect()

  return socket
}

interface PaymentChunkData {
  // TODO do we need to send all of these numbers?
  amountExpected: BigNumber,
  amountWanted: BigNumber,
  destinationAccount?: string
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

  return {
    amountExpected,
    amountWanted,
    destinationAccount
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
