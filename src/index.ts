import * as PSK2 from 'ilp-protocol-psk2'
import * as Debug from 'debug'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import EventEmitter = require('eventemitter3')
import * as oer from 'oer-utils'
import * as Long from 'long'
import * as assert from 'assert'
import 'source-map-support/register'

const MAX_UINT64 = new BigNumber('18446744073709551615')
const DEFAULT_STABILIZED_TIMEOUT = 60000
const PROBE_AMOUNT = 1000
const STARTING_RETRY_TIMEOUT = 100
const RETRY_TIMEOUT_INCREASE_FACTOR = 2
const AMOUNT_DECREASE_FACTOR = 0.5

const TYPE_CLOSE = 0
const TYPE_CHUNK = 1
const CLOSE_MESSAGE = Buffer.alloc(1, TYPE_CLOSE)
export const SHARED_SECRET_PREFIX = Buffer.from('payment-socket:', 'utf8')

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
  slippage?: BigNumber.Value,
  minBalance?: BigNumber.Value,
  maxBalance?: BigNumber.Value
}

export class PaymentSocket extends EventEmitter {
  // Configuration
  protected _destinationAccount: string
  protected _sharedSecret: Buffer
  protected sharedSecretWithPrefix: Buffer
  protected plugin: any
  protected peerDestinationAccount?: string
  protected debug: Debug.IDebugger
  protected socketTimeout: number
  protected enableRefunds: boolean
  protected slippage: BigNumber

  // Balance and Limits
  protected _balance: BigNumber
  protected peerWants: BigNumber
  protected peerExpects: BigNumber
  protected _minBalance: BigNumber
  protected _maxBalance: BigNumber

  // Path Maximum
  protected maxPaymentSize: BigNumber
  protected nextMaxAmount: BigNumber

  // Stats
  protected _totalSent: BigNumber
  protected _totalDelivered: BigNumber
  protected _exchangeRate: BigNumber
  protected numIncomingChunksFulfilled: number
  protected numIncomingChunksRejected: number
  protected numOutgoingChunksFulfilled: number
  protected numOutgoingChunksRejected: number

  // Status
  protected closed: boolean
  protected sending: boolean
  protected shouldSendAddressToPeer: boolean
  protected connected: boolean
  protected retryTimeout: number
  protected requestId: number

  constructor (opts: PaymentSocketOpts) {
    super()
    // TODO maybe these statements should have an ID that matches the destinationAccount and keyId seen in the logs from other modules
    this.debug = Debug(`ilp-protocol-paystream:PaymentSocket${opts.identity ? ':' + opts.identity : ''}`)

    this.plugin = opts.plugin
    this._destinationAccount = opts.destinationAccount
    if (!SHARED_SECRET_PREFIX.equals(opts.sharedSecret.slice(0, SHARED_SECRET_PREFIX.length))) {
      throw new Error('Shared secret and destination account are not for a Payment Socket (must start with "payment-socket:")')
    }
    this.sharedSecretWithPrefix = opts.sharedSecret
    this._sharedSecret = opts.sharedSecret.slice(SHARED_SECRET_PREFIX.length)
    this.peerDestinationAccount = opts.peerDestinationAccount
    this.socketTimeout = opts.timeout || 60000
    this.enableRefunds = !!opts.enableRefunds
    this.slippage = (opts.slippage !== undefined ? new BigNumber(opts.slippage) : new BigNumber(0.01))
    this.shouldSendAddressToPeer = !!opts.sendAddress

    this._balance = new BigNumber(0)
    this._minBalance = new BigNumber(opts.minBalance || 0)
    this._maxBalance = new BigNumber(opts.maxBalance || 0)
    this.peerExpects = new BigNumber(0)
    this.peerWants = new BigNumber(Infinity) // assume they want to get paid until they tell us otherwise
    this.maxPaymentSize = new BigNumber(Infinity) // this will be adjusted as we send chunks
    this.nextMaxAmount = new BigNumber(Infinity) // this will be adjusted as we send chunks
    this._totalSent = new BigNumber(0)
    this._totalDelivered = new BigNumber(0)
    this.numIncomingChunksFulfilled = 0
    this.numIncomingChunksRejected = 0
    this.numOutgoingChunksFulfilled = 0
    this.numOutgoingChunksRejected = 0
    this.closed = false
    this.sending = false
    this.connected = false
    this.retryTimeout = STARTING_RETRY_TIMEOUT
    this.requestId = 0
    this.debug(`new socket created with minBalance ${this._minBalance}, maxBalance ${this._maxBalance}, slippage: ${this.slippage}, and refunds ${this.enableRefunds ? 'enabled' : 'disabled'}`)
  }

  get destinationAccount (): string {
    return this._destinationAccount
  }

  get sharedSecret (): Buffer {
    return this.sharedSecretWithPrefix
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

  getExchangeRate (): string {
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
    this.startSending()
  }

  setMaxBalance (amount: BigNumber.Value): void {
    if (this._minBalance.isGreaterThan(amount)) {
      throw new Error(`Cannot set maxBalance lower than minBalance (${this._minBalance})`)
    }
    this.debug(`setting maxBalance to ${amount}`)
    this._maxBalance = new BigNumber(amount)

    /* tslint:disable-next-line:no-floating-promises */
    this.startSending()
  }

  setMinAndMaxBalance (amount: BigNumber.Value): void {
    this.debug(`setting minBalance and maxBalance to ${amount}`)
    this._minBalance = new BigNumber(amount)
    this._maxBalance = new BigNumber(amount)

    /* tslint:disable-next-line:no-floating-promises */
    this.startSending()
  }

  async connect (timeout = DEFAULT_STABILIZED_TIMEOUT): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Socket is already closed'))
    }

    if (this.connected) {
      return Promise.resolve()
    }

    /* tslint:disable-next-line:no-floating-promises */
    this.startSending()

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
      const closeListener = () => {
        cleanup.call(this)
        reject(new Error('Peer closed connection'))
      }

      function cleanup () {
        clearTimeout(timer)
        this.removeListener('error', errorListener)
        this.removeListener('connect', connectListener)
        this.removeListener('close', closeListener)
      }

      this.once('error', errorListener)
      this.once('connect', connectListener)
      this.once('close', closeListener)
      /* tslint:disable-next-line:no-unnecessary-type-assertion */
    }) as Promise<void>
  }

  async close () {
    this.debug(`closing payment socket with destinationAccount: ${this._destinationAccount}`)
    this.closed = true
    this.connected = false
    this.emit('close')

    if (!this.peerDestinationAccount) {
      this.debug(`not sending close message to peer because we don't know their account`)
      return
    }

    await PSK2.sendRequest(this.plugin, {
      destinationAccount: this.peerDestinationAccount,
      sharedSecret: this._sharedSecret,
      sourceAmount: '0',
      data: CLOSE_MESSAGE,
      unfulfillableCondition: randomBytes(32),
      requestId: this.requestId++
    })
    this.debug('sent close message to peer')
  }

  async stabilized (timeout = DEFAULT_STABILIZED_TIMEOUT): Promise<void> {
    if (this.isStabilized()) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.debug('stabilized timed out')
        cleanup.call(this)
        reject(new Error('Timed out without stabilizing'))
      }, timeout)
      const errorListener = (err: Error) => {
        this.debug('stabilized got error:', err)
        cleanup.call(this)
        reject(err)
      }
      const stabilizedListener = () => {
        cleanup.call(this)
        this.debug('stabilized')
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

  async pay (amount: BigNumber.Value) {
    assert(new BigNumber(amount).isGreaterThan(0), 'amount must be positive')

    if (!this._maxBalance.isFinite()) {
      this._maxBalance = this._balance
    }

    this._maxBalance = this._maxBalance.minus(amount)
    if (this._minBalance.isGreaterThan(this._maxBalance)) {
      this._minBalance = this._maxBalance
    }

    this.debug(`paying ${amount} (lowered maxBalance to: ${this._maxBalance}, minBalance: ${this._minBalance})`)

    /* tslint:disable-next-line:no-floating-promises */
    this.startSending()

    // Wait for the socket to stabilize
    // Note that if the user changes the limits before the socket is stabilized,
    // it will only resolve when the new limit is reached (whether it is higher or lower)
    await this.stabilized()

    this.debug(`paid ${amount}`)
  }

  async charge (amount: BigNumber.Value) {
    assert(new BigNumber(amount).isGreaterThan(0), 'amount must be positive')

    this._minBalance = this._minBalance.plus(amount)
    if (this._maxBalance.isLessThanOrEqualTo(this._minBalance)) {
      this._maxBalance = this._minBalance
    }

    this.debug(`charging ${amount} (raised minBalance to: ${this._minBalance}, maxBalance: ${this._maxBalance})`)

    /* tslint:disable-next-line:no-floating-promises */
    this.startSending()

    // Wait for the socket to stabilize
    // Note that if the user changes the limits before the socket is stabilized,
    // it will only resolve when the new limit is reached (whether it is higher or lower)
    await this.stabilized()

    this.debug(`charged ${amount}`)
  }

  payUpTo (amount: BigNumber.Value) {
    assert(new BigNumber(amount).isGreaterThan(0), 'amount must be positive')

    this._minBalance = this._minBalance.minus(amount)

    this.debug(`payUpTo ${amount} (minBalance: ${this._minBalance})`)

    /* tslint:disable-next-line:no-floating-promises */
    this.startSending()
  }

  chargeUpTo (amount: BigNumber.Value) {
    assert(new BigNumber(amount).isGreaterThan(0), 'amount must be positive')

    if (!this._maxBalance.isFinite()) {
      this._maxBalance = this._balance
    }
    this._maxBalance = this._maxBalance.plus(amount)

    this.debug(`chargeUpTo ${amount} (maxBalance: ${this._maxBalance})`)

    /* tslint:disable-next-line:no-floating-promises */
    this.startSending()
  }

  async handleRequest (request: PSK2.RequestHandlerParams): Promise<void> {
    // Start processing on the next tick of the event loop in case there are
    // other requests being processed right now that will change what we should do for this one
    await new Promise((resolve, reject) => setImmediate(resolve))

    this.debug(`handling request with amount: ${request.amount}`)
    this.logStats()
    if (this.closed) {
      this.debug('rejecting request because the socket is closed')
      return request.reject(CLOSE_MESSAGE)
    }

    const closeChannel = this.parseChunkData(request.data)
    if (closeChannel) {
      this.debug('peer closed socket')
      this.emit('close')
      this.closed = true
    }

    if (this.peerExpects.isGreaterThan(0) && this._balance.isGreaterThan(this._minBalance)) {
      this.debug('peer is requesting money')
      /* tslint:disable-next-line:no-floating-promises */
      this.startSending()
    }

    const requestAmount = new BigNumber(request.amount.toString())

    // After the other side's first request to us,
    // we assume that them sending 0 when we requested money means they're not going to send it
    // TODO we need a more definitive way of knowing whether they are going to send more
    if (requestAmount.isEqualTo(0)
      && this._balance.isLessThan(this._minBalance)
      && this.numIncomingChunksFulfilled + this.numIncomingChunksRejected > 1) {
      this.debug(`requested money from other party but they aren't sending it`)
      // TODO is this always an error? What if we changed the limit between now and when the other side sent this request?
      this.emit('error', new Error(`Requested money from other party but they aren't sending it. Current balance: ${this._balance}, expected: ${this._minBalance}`))
    }

    if (!request.isFulfillable) {
      // TODO disconnect if we get too many of these
      this.debug(`rejecting unfulfillable request`)
      this.numIncomingChunksRejected += 1
      return request.reject(serializeChunkData({
        amountExpected: this._minBalance.minus(this._balance),
        amountWanted: this._maxBalance.minus(this._balance)
        // don't include destinationAccount because the other side already knows it
      }))
    }

    // The other side has exceeded our maxBalance
    if (requestAmount.isGreaterThan(0) && this._balance.isGreaterThanOrEqualTo(this._maxBalance)) {
      this.debug(`rejecting request because balance is already at maximum`)
      this.numIncomingChunksRejected += 1
      return request.reject(serializeChunkData({
        amountExpected: this._minBalance.minus(this._balance),
        amountWanted: this._maxBalance.minus(this._balance)
        // don't include destinationAccount because the other side already knows it
      }))
    }

    // TODO should we reject requests with 0 amounts?

    // TODO make sure accept() call succeeds before increasing balance
    this._balance = this._balance.plus(requestAmount)
    const amountExpected = forceValueToBeBetween(this._minBalance.minus(this._balance), 0, MAX_UINT64)
    const amountWanted = forceValueToBeBetween(this._maxBalance.minus(this._balance), 0, MAX_UINT64)
    this.debug(`telling peer we expect: ${amountExpected} and want: ${amountWanted}`)
    this.numIncomingChunksFulfilled += 1
    request.accept(serializeChunkData({
      amountExpected,
      amountWanted
      // don't include destinationAccount because the other side already knows it
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

    this.debug(`accepted request with amount ${requestAmount}`)
    this.logStats()

    // Check if the socket has stabilized (both sides are satisfied)
    if (this.isStabilized()) {
      this.debug('socket stabilized')
      this.emit('stabilized')
    }
  }

  protected async startSending (): Promise<void> {
    // Make sure we don't have two loops sending at the same time
    if (this.sending) {
      this.debug('already in the process of sending, not starting another send loop')
      return
    }
    this.debug('sending started')
    // This will be set again in maybeSend but we need to set it here before the
    // `await Promise.resolve()` below in case startSending is called again
    this.sending = true

    // Wait until they've told us their address or close the socket if a timeout is reached
    if (!this.peerDestinationAccount) {
      this.debug('waiting for the other side to tell us their ILP address')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup.call(this)
          resolve()
        }, this.socketTimeout)

        const chunkListener = () => {
          if (this.peerDestinationAccount) {
            cleanup.call(this)
            resolve()
          }
        }
        this.on('chunk', chunkListener)

        function cleanup () {
          clearTimeout(timer)
          this.removeListener('chunk', chunkListener)
        }
      })
      if (!this.peerDestinationAccount) {
        this.debug('did not get destinationAccount from other side within timeout, closing socket')
        this.emit('error', new Error('Did not get destinationAccount from other party within timeout'))
        return this.close()
      }
    }

    // Start on the next tick of the event loop
    // This ensures that if someone calls "await socket.stabilized" right after changing the limit
    // the "stabilized" event will fire _after_ the listener has been added, even if the socket is stabilized when it starts
    await new Promise((resolve, reject) => setImmediate(resolve))

    try {
      await this.maybeSend()
    } catch (err) {
      this.debug('error while sending:', err)
      this.emit('error', err)
    }

    this.debug('sending finished')
  }

  protected async maybeSend (): Promise<void> {
    let shouldContinue = true
    this.sending = true
    this.debug(`maybeSend`)
    this.logStats()

    // Determine if we're requesting money or pushing money
    // (A request for money is just a 0-amount packet that updates our min/max values)
    let unfulfillableCondition: Buffer | undefined = undefined
    let sourceAmount
    if (this._balance.isLessThan(this._minBalance)) {
      // Request payment
      sourceAmount = new BigNumber(0)
      this.debug(`requesting payment from peer`)
      // Don't keep looping because we're just going to send one request for money and then wait to get paid
      shouldContinue = false
    } else if (this._balance.isGreaterThan(this._maxBalance) && this.peerWants.isGreaterThan(0)) {
      // Send payment (because our balance is too high)
      sourceAmount = this._balance.minus(this._maxBalance)
      sourceAmount = forceValueToBeBetween(sourceAmount, 0, this.nextMaxAmount)

      // Adjust how much we're sending to the receiver's maximum
      if (this._exchangeRate) {
        const sourceAmountReceiverWants = this.peerWants.dividedBy(this._exchangeRate).decimalPlaces(0, BigNumber.ROUND_CEIL)
        sourceAmount = BigNumber.min(sourceAmount, sourceAmountReceiverWants)
      }
      this.debug(`pushing ${sourceAmount} to peer`)
    } else if (this.peerExpects.isGreaterThan(0)) {
      // Peer is requesting payment, so pay until we've reached our minBalance
      // TODO adjust based on exchange rate and how much peer wants
      sourceAmount = BigNumber.min(this._balance.minus(this._minBalance), this.nextMaxAmount)
      sourceAmount = forceValueToBeBetween(sourceAmount, 0, this.nextMaxAmount)

      // Adjust how much we're sending to the receiver's minimum
      if (this._exchangeRate) {
        const sourceAmountReceiverExpects = this.peerExpects.dividedBy(this._exchangeRate).decimalPlaces(0, BigNumber.ROUND_CEIL)
        sourceAmount = BigNumber.min(sourceAmount, sourceAmountReceiverExpects)
      }

      if (sourceAmount.isEqualTo(0)) {
        this.debug('peer requested money but we are already at our minimum balance')
        shouldContinue = false
      }
      this.debug(`sending ${sourceAmount} because peer requested payment`)
    } else if (this.shouldSendAddressToPeer || !this._exchangeRate) {
      // Send a dummy request just to tell the other side our details and determine the exchange rate
      // TODO the initialization call should just be separate from this flow
      sourceAmount = new BigNumber(PROBE_AMOUNT)
      unfulfillableCondition = randomBytes(32)
      this.debug(`sending unfulfillable request just to tell the other party our address and to determine the exchange rate`)
    } else {
      this.sending = false
      this.debug(`don't need to send or request money`)
      if (this.isStabilized()) {
        this.debug('socket stabilized')
        this.emit('stabilized')
      } else {
        this.debug('cannot send anymore but we have not yet reached our limits')
        this.emit('error', new Error(`Stopped outside of the balance window. Current balance is: ${this._balance}, minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance}`))
      }
      return
    }

    // Use the exchange rate to determine the minDestinationAmount the receiver should accept for this chunk
    let minDestinationAmount
    if (this._exchangeRate) {
      minDestinationAmount = sourceAmount
        .times(this._exchangeRate)
        .times(new BigNumber(1).minus(this.slippage))
        .decimalPlaces(0, BigNumber.ROUND_FLOOR)
      minDestinationAmount = forceValueToBeBetween(minDestinationAmount, 0, MAX_UINT64)
      if (sourceAmount.isGreaterThan(0)) {
        this.debug(`setting minDestinationAmount to ${minDestinationAmount}, based on an exchange rate of ${this._exchangeRate} and slippage of ${this.slippage.times(100)}%`)
      }
    } else if (unfulfillableCondition) {
      minDestinationAmount = MAX_UINT64
    } else {
      minDestinationAmount = new BigNumber(0)
    }

    // Send the chunk
    const requestId = this.requestId++
    const amountExpected = forceValueToBeBetween(this._minBalance.minus(this._balance), 0, MAX_UINT64)
    const amountWanted = forceValueToBeBetween(this._maxBalance.minus(this._balance), 0, MAX_UINT64)
    this.debug(`sending request ${requestId} and telling our peer we expect: ${amountExpected} and want: ${amountWanted}`)
    const result = await PSK2.sendRequest(this.plugin, {
      destinationAccount: this.peerDestinationAccount!,
      sharedSecret: this._sharedSecret,
      sourceAmount: sourceAmount.toString(),
      data: serializeChunkData({
        amountExpected,
        amountWanted,
        destinationAccount: (this.shouldSendAddressToPeer ? this._destinationAccount : undefined)
      }),
      unfulfillableCondition,
      minDestinationAmount: minDestinationAmount.toString(),
      requestId
    })

    // TODO what if our message doesn't get through?
    this.shouldSendAddressToPeer = false

    // we need to convert to string just because the BigNumber version used by PSK2 right now is incompatible with the one this module uses :/
    const destinationAmount = new BigNumber(result.destinationAmount.toString(10))

    this.debug(`handling result of request: ${requestId}`)
    const closeSocket = this.parseChunkData(result.data)
    if (closeSocket) {
      shouldContinue = false
    }

    // Determine exchange rate
    // Right now this will only be done on the first chunk and won't change from there
    // TODO should the exchange rate be allowed to change with each chunk?
    // (we need to make sure connectors can't just make each chunk progressively worse by the slippage amount)
    if (!closeSocket && !this._exchangeRate && destinationAmount.isGreaterThan(0)) {
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
      this.numOutgoingChunksFulfilled += 1
      this._balance = this._balance.minus(sourceAmount)
      this.debug(`sent chunk of ${sourceAmount}`)
      this.logStats()
      this.emit('outgoing_chunk', sourceAmount.toString())
      this.emit('chunk')

      // This request succeeded to reset our retry-related variables
      this.retryTimeout = STARTING_RETRY_TIMEOUT

      // Adjust the chunk amount
      if (this.maxPaymentSize.isFinite() && sourceAmount.isLessThan(this.maxPaymentSize)) {
        this.nextMaxAmount = this.maxPaymentSize
          .minus(sourceAmount)
          .dividedBy(2)
          .plus(sourceAmount)
          .decimalPlaces(0, BigNumber.ROUND_DOWN)
        this.debug(`setting the nextMaxAmount to ${this.nextMaxAmount} (path maximum payment size is at most: ${this.maxPaymentSize})`)
      }
    } else {
      this.numOutgoingChunksRejected += 1

      if (result.code === 'F08') {
        // Amount too large

        // Use the F08 error data to determine the path Maximum Payment Size
        const reader = oer.Reader.from(result.unauthenticatedData)
        try {
          const receivedAmount = highLowToBigNumber(reader.readUInt64())
          const maximumAmount = highLowToBigNumber(reader.readUInt64())
          if (maximumAmount.isGreaterThanOrEqualTo(receivedAmount)) {
            const errMessage = `F08 error data includes a receivedAmount (${receivedAmount}) that is less than the reported maximumAmount (${maximumAmount}), which makes no sense`
            this.debug(errMessage)
            throw new Error(errMessage)
          }

          // If we got here without an error being thrown that means the connector
          // did actually send those values back (thanks!)
          const scalingFactor = maximumAmount.dividedBy(receivedAmount)
          this.maxPaymentSize = sourceAmount.times(scalingFactor).decimalPlaces(0, BigNumber.ROUND_FLOOR)
          this.nextMaxAmount = this.maxPaymentSize
          this.debug(`maximum sourceAmount the path can support is at most: ${this.maxPaymentSize}`)
        } catch (err) {
          // The connector didn't set the receivedAmount and maximumAmount
          // so we'll just try decreasing by some factor to try to discover the path MPS
          this.maxPaymentSize = sourceAmount.minus(1)
          this.nextMaxAmount = sourceAmount.times(AMOUNT_DECREASE_FACTOR).decimalPlaces(0, BigNumber.ROUND_DOWN)
          this.debug(`connector did not include receivedAmount and maximumAmount in reject, decreasing nextMaxAmount to: ${this.nextMaxAmount}`)
        }

        if (this.maxPaymentSize.isLessThanOrEqualTo(1)) {
          this.debug(`sending through this path is impossible because the maximum packet amount appears to be zero`)
          this.emit('error', new Error('Cannot send through this path because the maximum packet amount appears to be zero'))
          shouldContinue = false
        }
      } else if (unfulfillableCondition) {
        // We sent an unfulfillable test payment so of course it was rejected

        this.debug(`request was rejected because it was unfulfillable`)
      } else if (destinationAmount.isGreaterThan(0) && minDestinationAmount.isGreaterThan(result.destinationAmount.toString(10))) {
        // Receiver rejected because too little arrived

        this.debug(`receiver rejected packet because too little arrived. actual destination amount: ${result.destinationAmount}, expected: ${minDestinationAmount} (sourceAmount: ${sourceAmount}, expected exchange rate: ${this._exchangeRate})`)

        // Retry in case the rate improves again
        await new Promise((resolve, reject) => setTimeout(resolve, this.retryTimeout))
        this.retryTimeout = this.retryTimeout * RETRY_TIMEOUT_INCREASE_FACTOR
      } else if (result.code[0].toUpperCase() === 'T') {
        // Retry on temporary rejection codes

        this.debug(`got temporary error code: ${result.code}, message: ${result.message}. waiting ${this.retryTimeout}ms before retrying`)
        await new Promise((resolve, reject) => setTimeout(resolve, this.retryTimeout))
        this.retryTimeout = this.retryTimeout * RETRY_TIMEOUT_INCREASE_FACTOR
      } else {
        // Unexpected error

        this.debug(`sending chunk failed with code: ${result.code} and message: ${result.message}`)
        this.emit('error', new Error(`Sending chunk failed with code: ${result.code} and message: ${result.message}`))
        shouldContinue = false
      }
    }

    this.sending = false
    if (shouldContinue) {
      return this.maybeSend()
    } else if (this.isStabilized()) {
      this.emit('stabilized')
      this.debug('socket stabilized')
    } else {
      // TODO we need a more definitive way of knowing whether they are going to send more
      this.debug(`socket is not yet stabilized, but not continuing to send`)
      this.logStats()
    }

    if (closeSocket) {
      this.debug('peer closed socket')
      this.closed = true
      this.emit('close')
    }
  }

  protected logStats (): void {
    this.debug(`balance: ${this._balance}, minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance}, peerExpects: ${this.peerExpects}, peerWants: ${this.peerWants}, totalSent: ${this._totalSent}, totalDelivered: ${this._totalDelivered}, numIncomingChunksFulfilled: ${this.numIncomingChunksFulfilled}, numIncomingChunksRejected: ${this.numIncomingChunksRejected}, numOutgoingChunksFulfilled: ${this.numOutgoingChunksFulfilled}, numOutgoingChunksRejected: ${this.numOutgoingChunksRejected}`)
  }

  protected parseChunkData (data: Buffer): boolean {
    if (data.length === 0) {
      return false
    }

    try {
      const chunkData = deserializePacket(data)
      if (isSocketChunkData(chunkData)) {
        this.peerWants = chunkData.amountWanted
        this.peerExpects = chunkData.amountExpected
        this.peerDestinationAccount = chunkData.destinationAccount || this.peerDestinationAccount
        this.debug(`parsed chunk data. peerExpects: ${this.peerExpects}, peerWants: ${this.peerWants}`)
        return false
      } else {
        this.debug('parsed socket close or unknown message')
        return true
      }
    } catch (err) {
      this.debug('unable to parse chunk data from peer:', err)
      return false
    }
  }
}

export interface ServerCreateSocketOpts {
  enableRefunds?: boolean,
  slippage?: BigNumber.Value,
  maxBalance?: BigNumber.Value,
  minBalance?: BigNumber.Value
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
      await socket.close()
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
      sharedSecret: Buffer.concat([SHARED_SECRET_PREFIX, sharedSecret]),
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
      return request.reject(CLOSE_MESSAGE)
    }

    const socket = this.sockets.get(request.keyId.toString('hex'))
    if (!socket) {
      this.debug(`rejecting request for keyId: ${request.keyId.toString('hex')} because there is no open socket with that ID`)
      // TODO send a better error message so the sender knows exactly what's going on
      return request.reject(CLOSE_MESSAGE)
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
  slippage?: BigNumber.Value
}

export async function createSocket (opts: CreateSocketOpts) {
  const debug = Debug('ilp-protocol-paystream:createSocket')
  let socket: PaymentSocket
  const receiver = await PSK2.createReceiver({
    plugin: opts.plugin
  })
  const sharedSecretWithoutPrefix = opts.sharedSecret.slice(SHARED_SECRET_PREFIX.length)
  const { destinationAccount } = receiver.registerRequestHandlerForSecret(sharedSecretWithoutPrefix, (request: PSK2.RequestHandlerParams) => {
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
    slippage: (opts.slippage !== undefined ? new BigNumber(opts.slippage) : undefined)
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

interface SocketClose {
}

interface SocketChunkData {
  // TODO do we need to send all of these numbers?
  amountExpected: BigNumber,
  amountWanted: BigNumber,
  destinationAccount?: string
}

function isSocketChunkData (packet: SocketClose | SocketChunkData): packet is SocketChunkData {
  return packet.hasOwnProperty('amountExpected')
}

function serializeChunkData (chunkData: SocketChunkData): Buffer {
  const amountExpected = forceValueToBeBetween(chunkData.amountExpected, 0, MAX_UINT64)
  const amountWanted = forceValueToBeBetween(chunkData.amountWanted, 0, MAX_UINT64)

  const writer = new oer.Writer()
  writer.writeUInt8(TYPE_CHUNK)
  writer.writeUInt64(bigNumberToHighLow(amountExpected))
  writer.writeUInt64(bigNumberToHighLow(amountWanted))
  writer.writeVarOctetString(Buffer.from(chunkData.destinationAccount || '', 'utf8'))
  return writer.getBuffer()
}

function deserializePacket (buffer: Buffer): SocketClose | SocketChunkData {
  const reader = oer.Reader.from(buffer)
  const packetType = reader.readUInt8()

  if (packetType === TYPE_CLOSE) {
    return {} as SocketClose
  } else if (packetType === TYPE_CHUNK) {
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
    } as SocketChunkData
  } else {
    throw new Error(`Unknown packet type: ${packetType}`)
  }
}

function forceValueToBeBetween (value: BigNumber.Value, min: BigNumber.Value, max: BigNumber.Value): BigNumber {
  return BigNumber.min(BigNumber.max(value, min), max)
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
