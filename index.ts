import * as PSK2 from 'ilp-protocol-psk2'
import * as Debug from 'debug'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import EventEmitter = require('eventemitter3')
import * as oer from 'oer-utils'

export class PaymentSocket extends EventEmitter {
  public readonly destinationAccount: string
  public readonly sharedSecret: Buffer
  protected plugin: any
  protected peerDestinationAccount?: string
  protected peerSharedSecret?: Buffer
  protected peerBalance: BigNumber
  protected peerMinBalance: BigNumber
  protected peerMaxBalance: BigNumber
  protected _balance: BigNumber
  protected _minBalance: BigNumber
  protected _maxBalance: BigNumber
  protected maxPaymentSize: BigNumber
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
    this.maxPaymentSize = new BigNumber(1000) // this will be adjusted as we send chunks
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
  
  setMinBalance (amount: BigNumber.Value): void {
    if (this._maxBalance.isLessThan(amount)) {
      throw new Error(`Cannot set minBalance lower than maxBalance (${this._maxBalance})`)
    }
    this.debug(`setting minBalance to ${amount}`)
    this._minBalance = new BigNumber(amount)
    this.maybeSend()
  }

  setMaxBalance (amount: BigNumber.Value): void {
    if (this._minBalance.isGreaterThan(amount)) {
      throw new Error(`Cannot set maxBalance lower than minBalance (${this._minBalance})`)
    }
    this.debug(`setting maxBalance to ${amount}`)
    this._maxBalance = new BigNumber(amount)
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

    // TODO check that the request doesn't put us too far over the maxBalance
    
    // TODO make sure accept() call succeeds before increasing balance
    this._balance = this._balance.plus(request.amount.toString(10))
    request.accept(serializeChunkData({
      balance: this._balance,
      minBalance: this._minBalance,
      maxBalance: this._maxBalance
      // don't include destinationAccount or sharedSecret because the other side already knows it
    }))
    this.emit('incoming_chunk', request.amount.toString())
    this.debug(`accepted request, balance is now: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance})`)
  }

  protected async maybeSend (): Promise<void> {
    // Make sure we don't have two loops sending at the same time
    if (this.sending) {
      return
    }
    this.sending = true

    if (!this.peerDestinationAccount || !this.peerSharedSecret) {
      this.debug('waiting for the other side to tell us their ILP address')
      setTimeout(() => {
        if (!this.peerDestinationAccount) {
          this.debug('did not get destinationAccount from other side within timeout, closing socket')
          this.close()
        }
      }, this.socketTimeout)
      this.sending = false
      return
    }

    if (this._balance.isLessThanOrEqualTo(this._minBalance)) {
      this.debug(`not sending any more, balance (${this._balance}) has reached minBalance (${this._minBalance})`)
      // TODO tell the other side we're waiting for them to send more
      this.sending = false
      return
    }

    const sourceAmount = BigNumber.min(this.maxPaymentSize, this._maxBalance.minus(this._balance))

    const result = await PSK2.sendRequest(this.plugin, {
      destinationAccount: this.peerDestinationAccount,
      sharedSecret: this.peerSharedSecret,
      sourceAmount: sourceAmount.toString(10),
      data: serializeChunkData({
        // TODO should this balance include the chunk we're sending?
        balance: this._balance,
        minBalance: this._minBalance,
        maxBalance: this._maxBalance,
        // TODO only send the destinationAccount and sharedSecret once
        destinationAccount: this.destinationAccount,
        sharedSecret: this.sharedSecret
      })
    })

    this.parseChunkData(result.data)

    if (!PSK2.isPskError(result)) {
      this._balance = this._balance.minus(sourceAmount)
      this.debug(`sent chunk, balance is now: ${this._balance} (minBalance: ${this._minBalance}, maxBalance: ${this._maxBalance})`)
      this.emit('outgoing_chunk', sourceAmount.toString())

      // TODO determine exchange rate
      // TODO determine how much more the receiver is waiting for
    } else {
      // TODO handle errors
      this.debug(`sending chunk failed with code: ${result.code}`)
    }

    return this.maybeSend()
  }

  protected parseChunkData (data: Buffer): void {
    if (data.length === 0) {
      this.debug('peer did not send any data in packet')
      return
    }

    try {
      const chunkData = deserializeChunkData(data)
      this.peerBalance = chunkData.balance
      this.peerMinBalance = chunkData.minBalance
      this.peerMaxBalance = chunkData.maxBalance
      this.peerDestinationAccount = chunkData.destinationAccount || this.peerDestinationAccount
      this.peerSharedSecret = chunkData.sharedSecret || this.peerSharedSecret
    } catch (err) {
      this.debug('unable to parse chunk data from peer:', err)
    }
  }
}

export class PaymentServer {
  protected receiver: PSK2.Receiver
  protected sockets: Map<Buffer, PaymentSocket> 
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
    if (keyId && this.sockets.has(keyId)) {
      this.debug(`socket already exists with id:${keyId.toString('hex')}`)
      return this.sockets.get(keyId)!
    }

    const socketId = keyId || randomBytes(18)
    const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret(socketId)
    const socket = new PaymentSocket(this.plugin, destinationAccount, sharedSecret)
    this.sockets.set(socketId, socket)
    this.debug(`created new socket with id: ${socketId.toString('hex')}`)

    socket.once('close', () => { this.sockets.delete(socketId) })

    return socket
  }

  async handleRequest (request: PSK2.RequestHandlerParams): Promise<void> {
    if (!request.keyId) {
      this.debug('rejecting request because it does not have a keyId so it was not created by a PaymentServer')
      return request.reject()
    }

    const socket = this.sockets.get(request.keyId)
    if (!socket) {
      this.debug(`rejecting request for keyId: ${request.keyId.toString('hex')} because there is no open socket with that ID`)
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
  let socket: PaymentSocket
  const receiver = await PSK2.createReceiver({
    plugin: opts.plugin,
    requestHandler: (request: PSK2.RequestHandlerParams) => {
      if (!Buffer.isBuffer(request.keyId) || !keyId.equals(request.keyId)) {
        // TODO tell the other side why we're rejecting it
        return request.reject()
      }

      if (socket) {
        socket.handleRequest(request)
      } else {
        // TODO what should we do here?
      }
    }
  })
  const { destinationAccount, sharedSecret } = receiver.generateAddressAndSecret()
  socket = new PaymentSocket(opts.plugin, destinationAccount, sharedSecret, opts.destinationAccount, opts.sharedSecret)
  if (opts.minBalance !== undefined) {
    socket.setMinBalance(opts.minBalance)
  }
  if (opts.maxBalance !== undefined) {
    socket.setMaxBalance(opts.maxBalance)
  }

  socket.once('close', () => {
    receiver.disconnect()
  })

  return socket
}

interface PaymentChunkData {
  // TODO do we need to send all of these numbers?
  balance: BigNumber,
  minBalance: BigNumber,
  maxBalance: BigNumber,
  destinationAccount?: string,
  sharedSecret?: Buffer
}

function serializeChunkData (chunkData: PaymentChunkData): Buffer {
  const writer = new oer.Writer()
  writer.writeVarInt(Buffer.from(chunkData.balance.toString(16), 'hex'))
  writer.writeVarInt(Buffer.from(chunkData.minBalance.toString(16), 'hex'))
  writer.writeVarInt(Buffer.from(chunkData.maxBalance.toString(16), 'hex'))
  writer.writeVarOctetString(Buffer.from(chunkData.destinationAccount || '', 'utf8'))
  writer.writeVarOctetString(chunkData.sharedSecret || Buffer.alloc(0))
  return writer.getBuffer()
}

function deserializeChunkData (buffer: Buffer): PaymentChunkData {
  const reader = oer.Reader.from(buffer)
  const balance = new BigNumber(reader.readVarOctetString().toString('hex'), 16)
  const minBalance = new BigNumber(reader.readVarOctetString().toString('hex'), 16)
  const maxBalance = new BigNumber(reader.readVarOctetString().toString('hex'), 16)
  let destinationAccount: string | undefined = reader.readVarOctetString().toString('utf8')
  if (destinationAccount === '') {
    destinationAccount = undefined
  }
  let sharedSecret: Buffer | undefined = reader.readVarOctetString()
  if (sharedSecret.length === 0) {
    sharedSecret = undefined
  }

  return {
    balance,
    minBalance,
    maxBalance,
    destinationAccount,
    sharedSecret
  }
}
