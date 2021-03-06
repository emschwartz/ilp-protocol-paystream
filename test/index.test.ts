import 'mocha'
import * as chai from 'chai'
import * as chaiAsPromised from 'chai-as-promised'
chai.use(chaiAsPromised)
const assert = chai.assert
import { createSocket, createServer, PaymentServer, PaymentSocket } from '../src/index'
import MockPlugin from './mocks/plugin'
import * as sinon from 'sinon'
import * as IlpPacket from 'ilp-packet'
import * as PSK2 from 'ilp-protocol-psk2'
import * as lolex from 'lolex'

describe('PaymentSocket', function () {
  beforeEach(async function () {
    this.pluginA = new MockPlugin(0.5)
    this.pluginB = this.pluginA.mirror

    this.server = await createServer({
      plugin: this.pluginB,
      secret: Buffer.alloc(32)
    })
    this.serverSocket = this.server.createSocket({
      maxBalance: Infinity
    })

    this.clientSocket = await createSocket({
      plugin: this.pluginA,
      destinationAccount: this.serverSocket.destinationAccount,
      sharedSecret: this.serverSocket.sharedSecret,
      maxBalance: Infinity
    })
  })

  describe('Exported properties', function () {
    it('should export the destinationAccount and sharedSecret as readonly', function () {
      assert.typeOf(this.clientSocket.destinationAccount, 'string')
      assert(Buffer.isBuffer(this.clientSocket.sharedSecret))
      assert.throws(() => this.clientSocket.destinationAccount = 'blah')
      assert.throws(() => this.clientSocket.sharedSecret = Buffer.alloc(0))
    })

    it('should export the sharedSecret with the prefix "payment-socket:"', function () {
      const prefix = 'payment-socket:'
      assert.equal(this.clientSocket.sharedSecret.slice(0, Buffer.from(prefix, 'utf8').length).toString('utf8'), prefix)
      assert.equal(this.serverSocket.sharedSecret.slice(0, Buffer.from(prefix, 'utf8').length).toString('utf8'), prefix)
    })

    it('should export the balance as a string but not allow it to be modified', function () {
      assert.typeOf(this.clientSocket.balance, 'string')
      assert.throws(() => this.clientSocket.balance = '10')
    })

    it('should export the minBalance as a string but not allow it to be modified', function () {
      assert.typeOf(this.clientSocket.minBalance, 'string')
      assert.throws(() => this.clientSocket.minBalance = '10')
    })

    it('should export the maxBalance as a string but not allow it to be modified', function () {
      assert.typeOf(this.clientSocket.maxBalance, 'string')
      assert.throws(() => this.clientSocket.maxBalance = '10')
    })

    it('should export the totalSent as a string but not allow it to be modified', function () {
      assert.typeOf(this.clientSocket.totalSent, 'string')
      assert.throws(() => this.clientSocket.totalSent = '10')
    })

    it('should export the totalDelivered as a string but not allow it to be modified', function () {
      assert.typeOf(this.clientSocket.totalDelivered, 'string')
      assert.throws(() => this.clientSocket.totalDelivered = '10')
    })
  })

  describe('connect', function () {
    it('should resolve on the client side when the exchange rate is known', async function () {
      await this.clientSocket.connect()
      assert.equal(this.clientSocket.getExchangeRate(), '0.5')
    })

    it('should resolve on the server side when the destination account and exchange rate are known', async function () {
      await this.serverSocket.connect()
      assert(this.serverSocket.destinationAccount)
      assert.equal(this.serverSocket.getExchangeRate(), '2')
    })

    it('should resolve if it is already connected', async function () {
      await this.clientSocket.connect()
      const spy = sinon.spy(this.pluginA, 'sendData')
      await this.clientSocket.connect()

      assert(spy.notCalled)
    })

    it('should throw an error if the socket is already closed', async function () {
      await this.clientSocket.connect()
      this.clientSocket.close()
      return assert.isRejected(this.clientSocket.connect(), 'Socket is already closed')
    })

    it('should allow the user to check if the socket is connected', async function () {
      assert.equal(this.serverSocket.isConnected(), false)
      await this.serverSocket.connect()
      assert.equal(this.serverSocket.isConnected(), true)
    })

    it('should reject if the other side is closed', async function () {
      await this.serverSocket.close()
      await assert.isRejected(this.clientSocket.connect(), 'Socket is already closed')
    })

    it.skip('should timeout after the specified timeout', async function () {

    })

    it.skip('should timeout after 60 seconds by default', async function () {

    })

    it('should reject packets that are not from other Payment Sockets', async function () {
      const result = await PSK2.sendRequest(this.pluginA, {
        destinationAccount: this.serverSocket.destinationAccount,
        sharedSecret: this.serverSocket.sharedSecret,
        sourceAmount: '10'
      })

      assert.equal(result.fulfilled, false)
    })
  })

  describe('close', function () {
    it('should disconnect the PSK2 receiver if it is a client socket', function () {
      const spy = sinon.spy(this.pluginA, 'disconnect')
      this.clientSocket.close()
      assert(spy.called)
    })

    it('should not disconnect the receiver if it is a server socket', async function () {
      const spy = sinon.spy(this.pluginB, 'disconnect')
      this.serverSocket.close()
      assert(spy.notCalled)
    })

    it('should reject packets if a server socket is closed', async function () {
      const clock = sinon.useFakeTimers()
      this.serverSocket.close()
      this.clientSocket.setMinAndMaxBalance(-1000)
      const notStabilized = this.clientSocket.stabilized()
      clock.tick(100000)
      await assert.isRejected(notStabilized, 'Timed out without stabilizing')
      clock.restore()
    })

    it('should close the other side if one side is closed', async function () {
      const spy = sinon.spy()
      this.serverSocket.on('close', spy)
      await this.clientSocket.close()
      assert.equal(spy.callCount, 1)
    })

    it('should reject the stabilized Promise if the other side closes before sending enough money', async function () {
      this.clientSocket.setMinAndMaxBalance(2000)
      setImmediate(() => this.serverSocket.close())
      await assert.isRejected(this.clientSocket.stabilized(), 'Sending chunk failed with code: F99 and message:')
    })
  })

  describe('setMaxBalance', function () {
    it('should throw an error if it is less than the minBalance', async function () {
      assert.throws(() => this.clientSocket.setMaxBalance(-1000))
    })

    it('should not do anything if the new value is higher than the current balance', async function () {
      this.clientSocket.setMaxBalance(1000)
      await this.clientSocket.stabilized()
      assert.equal(this.clientSocket.balance, '0')
    })
  })

  describe('setMinBalance', function () {
    it('should throw an error if it is greater than the maxBalance', async function () {
      this.clientSocket.setMaxBalance(1000)
      assert.throws(() => this.clientSocket.setMinBalance(2000))
    })

    it('should not do anything if the new value is lower than the current balance', async function () {
      this.clientSocket.setMinBalance(-1000)
      await this.clientSocket.stabilized()
      assert.equal(this.clientSocket.balance, '0')
    })
  })

  describe('pay', function () {
    it('should lower the maximum balance and resolve when the balance is below the maximum', async function () {
      await this.clientSocket.pay(2000)
      assert.equal(this.clientSocket.balance, '-2000')

      await this.clientSocket.pay(1500)
      assert.equal(this.clientSocket.balance, '-3500')
    })

    it('should reject if the amount is higher than the other party will accept', async function () {
      this.serverSocket.setMaxBalance(900)
      await assert.isRejected(this.clientSocket.pay(2000), 'Stopped outside of the balance window. Current balance is: -1800, minBalance: -2000, maxBalance: -2000')
    })

    it('should resolve when the socket has stabilized, even if the user changed the limits before it did', async function () {
      const payPromise = this.clientSocket.pay(2000)
      this.clientSocket.setMaxBalance(-1000)

      await payPromise

      assert.equal(this.clientSocket.balance, '-1000')
    })
  })

  describe('charge', function () {
    it('should raise the minimum balance and resolve when the balance is above the minimum', async function () {
      this.serverSocket.setMinBalance(-5000)

      await this.clientSocket.charge(2000)
      assert.equal(this.clientSocket.balance, '2000')
    })

    it('should raise the minimum balance further and resolve when the balance is above the new minimum if it starts above zero', async function () {
      this.serverSocket.setMinBalance(-5000)

      await this.clientSocket.charge(2000)
      assert.equal(this.clientSocket.balance, '2000')

      await this.clientSocket.charge(1500)
      assert.equal(this.clientSocket.balance, '3500')
    })

    it('should reject if the amount is higher than the other party is willing to pay', async function () {
      // use lolex directly until https://github.com/DefinitelyTyped/DefinitelyTyped/pull/23694 is merged
      const clock = lolex.install({
        toFake: ['setTimeout']
      })

      const notStabilized = this.clientSocket.charge(2000)
      clock.runAll()
      await assert.isRejected(notStabilized, 'Timed out without stabilizing')
      clock.uninstall()
    })

    it('should resolve when the socket has stabilized, even if the user changed the limits before it did', async function () {
      this.serverSocket.setMinBalance(-5000)

      const chargePromise = this.clientSocket.charge(2000)
      this.clientSocket.setMinBalance(1000)

      await chargePromise

      assert.equal(this.clientSocket.balance, '1000')
    })
  })

  describe('payUpTo', function () {
    it('should lower the min balance by the specified amount', async function () {
      this.clientSocket.payUpTo(1000)
      assert.equal(this.clientSocket.minBalance, '-1000')

      this.clientSocket.payUpTo(1500)
      assert.equal(this.clientSocket.minBalance, '-2500')
    })
  })

  describe('chargeUpTo', function () {
    it('should raise the max balance by the specified amount', async function () {
      this.serverSocket.chargeUpTo(1000)
      assert.equal(this.serverSocket.maxBalance, '1000')

      this.serverSocket.chargeUpTo(1500)
      assert.equal(this.serverSocket.maxBalance, '2500')
    })
  })

  describe('Events', function () {
    it('should emit "chunk" on every incoming or outgoing request', async function () {
      const clientSpy = sinon.spy()
      const serverSpy = sinon.spy()
      this.clientSocket.on('chunk', clientSpy)
      this.serverSocket.on('chunk', serverSpy)

      this.clientSocket.setMinAndMaxBalance(-2000)
      await this.clientSocket.stabilized()

      assert.equal(clientSpy.callCount, 2)
      assert.equal(serverSpy.callCount, 2)
    })
  })

  describe('Pushing money', function () {
    it('should send until the maximum balance is reached', async function () {
      this.clientSocket.setMinAndMaxBalance(-2000)
      await this.clientSocket.stabilized()

      assert.equal(this.serverSocket.balance, '1000')
    })

    it('should allow you to send more by lowering the max balance further', async function () {
      this.clientSocket.setMinAndMaxBalance(-1000)
      await this.clientSocket.stabilized()

      this.clientSocket.setMinAndMaxBalance(-3000)
      await this.clientSocket.stabilized()

      assert.equal(this.serverSocket.balance, '1500')
    })

    it('should not go above the maxBalance of the other side', async function () {
      this.clientSocket.setMinAndMaxBalance(-2000)
      this.serverSocket.setMaxBalance(750)
      await assert.isRejected(this.clientSocket.stabilized(), 'Stopped outside of the balance window. Current balance is: -1500, minBalance: -2000, maxBalance: -2000')
      assert.equal(this.serverSocket.balance, '750')
    })
  })

  describe('Pulling money', function () {
    it('should request money until the minimum balance is reached', async function () {
      this.clientSocket.setMinAndMaxBalance(2000)
      this.serverSocket.setMinBalance(-5000)

      await this.clientSocket.stabilized()

      assert.equal(this.clientSocket.balance, '2000')
    })

    it('should allow you to request more money by raising the minimum balance further', async function () {
      this.clientSocket.setMinBalance(-4000)
      this.serverSocket.setMinAndMaxBalance(1000)
      await this.clientSocket.stabilized()

      this.serverSocket.setMinAndMaxBalance(2000)
      await this.clientSocket.stabilized()

      await this.serverSocket.stabilized()
      assert.equal(this.serverSocket.balance, '2000')
    })

    it('should end up with exactly the right amount that it requests', async function () {
      this.clientSocket.setMinBalance(-4000)
      this.serverSocket.setMinAndMaxBalance(1750)

      await this.serverSocket.stabilized()

      assert.equal(this.serverSocket.balance, '1750')
    })

    it('should emit an "error" and reject the stabilized Promise if the other party is unwilling to pay as much as one side requests', async function () {
      const spy = sinon.spy()
      this.serverSocket.on('error', spy)
      this.serverSocket.setMinAndMaxBalance(2000)
      this.clientSocket.setMinBalance(-500)

      await assert.isRejected(this.serverSocket.stabilized(), 'Requested money from other party but they aren\'t sending it. Current balance: 250, expected: 2000')
      assert(spy.called)
    })

    it.skip('should stop sending as soon as it realizes the amount requested is too high')

    it('should not be able to pull more money than the other party\'s minBalance', async function () {
      this.serverSocket.setMinAndMaxBalance(2000)
      this.clientSocket.setMinBalance(-500)

      await assert.isRejected(this.serverSocket.stabilized(), 'Requested money from other party but they aren\'t sending it. Current balance: 250, expected: 2000')
      assert.equal(this.clientSocket.balance, '-500')
    })
  })

  describe('Refunds', function () {
    it('should be disabled by default', async function () {
      // use lolex directly until https://github.com/DefinitelyTyped/DefinitelyTyped/pull/23694 is merged
      const clock = lolex.install({
        toFake: ['setTimeout']
      })

      this.clientSocket.setMinAndMaxBalance(-1000)
      await this.clientSocket.stabilized()
      this.clientSocket.setMinAndMaxBalance(0)

      const notStabilized = this.clientSocket.stabilized()
      clock.runAll()
      await assert.isRejected(notStabilized, 'Timed out without stabilizing')
      assert.equal(this.serverSocket.balance, '500')
      clock.uninstall()
    })

    it('should allow the payer to request their money back if enabled', async function () {
      const clientSocket = await createSocket({
        plugin: this.pluginA,
        destinationAccount: this.serverSocket.destinationAccount,
        sharedSecret: this.serverSocket.sharedSecret,
        enableRefunds: true,
        maxBalance: Infinity
      })

      // Server is paying client
      this.serverSocket.setMinAndMaxBalance(-1000)
      await this.serverSocket.stabilized()

      this.serverSocket.setMinAndMaxBalance(0)
      await this.serverSocket.stabilized()

      assert.equal(this.serverSocket.balance, '0')
    })
  })

  describe('Exchange rate handling', function () {
    it('should throw an error if the exchangeRate is accessed before the socket is connected', function () {
      assert.throws(() => {
        let e = this.serverSocket.getExchangeRate()
      })
    })

    it('should determine the exchange rate when the client socket is connected', async function () {
      await this.clientSocket.connect()
      assert.equal(this.clientSocket.getExchangeRate(), '0.5')
    })

    it('should determine the exchange rate when the server socket is connected', async function () {
      await this.serverSocket.connect()
      assert.equal(this.serverSocket.getExchangeRate(), '2')
    })

    it('should retry packets if the exchange rate gets worse than the exchange rate * (1 + slippage)', async function () {
      const clock = lolex.install({
        toFake: ['setTimeout']
      })
      const interval = setInterval(() => clock.tick(100))

      const spy = sinon.spy()
      this.clientSocket.on('error', spy)

      this.clientSocket.setMinAndMaxBalance(-1000)
      await this.clientSocket.stabilized()

      this.pluginA.exchangeRate = 0.25
      let call = 0
      const realSendData = this.pluginA.sendData.bind(this.pluginA)
      this.pluginA.sendData = (data: Buffer) => {
        if (call++ >= 2) {
          this.pluginA.exchangeRate = 0.495
          this.pluginA.sendData = realSendData
        }

        return realSendData(data)
      }


      this.clientSocket.setMinAndMaxBalance(-2000)
      await this.clientSocket.stabilized()

      assert.equal(this.clientSocket.balance, '-2000')
      assert.equal(this.serverSocket.balance, '995')
      assert(spy.notCalled)

      clearInterval(interval)
    })

    it('should allow the exchange rate to move by the specified slippage', async function () {
      const clientSocket = await createSocket({
        plugin: this.pluginA,
        destinationAccount: this.serverSocket.destinationAccount,
        sharedSecret: this.serverSocket.sharedSecret,
        slippage: 0.5
      })

      clientSocket.setMinAndMaxBalance(-1000)
      await clientSocket.stabilized()

      this.pluginA.exchangeRate = 0.25

      clientSocket.setMinAndMaxBalance(-2000)
      await clientSocket.stabilized()
    })

    it('should default to allowing 1% slippage', async function () {
      this.clientSocket.setMinAndMaxBalance(-1000)
      await this.clientSocket.stabilized()

      this.pluginA.exchangeRate = 0.495

      this.clientSocket.setMinAndMaxBalance(-2000)
      await this.clientSocket.stabilized()
    })

    it('should expose the exchange rate discovered through sending', async function () {
      this.clientSocket.setMinAndMaxBalance(-1000)
      await this.clientSocket.stabilized()

      this.pluginA.exchangeRate = 0.495

      this.clientSocket.setMinAndMaxBalance(-2000)
      await this.clientSocket.stabilized()

      // average of the two rates
      assert.equal(this.clientSocket.getExchangeRate(), '0.4975')
    })
  })

  describe('Maximum Payment Size handling', function () {
    it('should find the MPS immediately if the connector returns the receivedAmount and maximumAmount in the F08 reject data', async function () {
      this.pluginA.maxAmount = 2500
      const spy = sinon.spy(this.pluginA, 'sendData')

      this.clientSocket.setMinAndMaxBalance(-5000)
      await this.clientSocket.stabilized()
      assert.equal(spy.callCount, 3)
      assert.equal(IlpPacket.deserializeIlpPrepare(spy.args[1][0]).amount, '2500')
    })

    it('should find the MPS if there are multiple connectors with successively smaller MPS\'', async function () {
      const maxAmounts = [2857, 2233, 1675]
      const realSendData = this.pluginA.sendData
      let callCount = 0
      const args: Buffer[] = []
      this.pluginA.sendData = (data: Buffer) => {
        callCount++
        args[callCount - 1] = data
        if (callCount <= maxAmounts.length) {
          this.pluginA.maxAmount = maxAmounts[callCount - 1]
        }
        return realSendData.call(this.pluginA, data)
      }

      this.clientSocket.setMinAndMaxBalance(-3000)
      await this.clientSocket.stabilized()
      // Look at the 2nd to last call, because the last one will be decreased based
      // on how much is left to send (rather than being set to the path MPS)
      const secondToLastCall = args[callCount - 2]
      assert.equal(IlpPacket.deserializeIlpPrepare(secondToLastCall).amount, '1675')
      assert.equal(callCount, 5)
    })

    it('should approximate the MPS even if the connector does not return the receivedAmount and maximumAmount in the F08 reject data', async function () {
      this.pluginA.maxAmount = 800
      const spy = sinon.spy(this.pluginA, 'sendData')
      const realSendData = this.pluginA.sendData
      this.pluginA.sendData = async (data: Buffer) => {
        let result = await realSendData.call(this.pluginA, data)
        if (result[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
          result = IlpPacket.serializeIlpReject({
            ...IlpPacket.deserializeIlpReject(result),
            data: Buffer.alloc(0)
          })
        }
        return result
      }

      this.clientSocket.setMinAndMaxBalance(-2000)
      await this.clientSocket.stabilized()
      assert.equal(spy.callCount, 5)
    })

    it('should send the whole amount in one chunk if it can', async function () {
      this.pluginA.maxAmount = 100000
      const spy = sinon.spy(this.pluginA, 'sendData')
      this.clientSocket.setMinAndMaxBalance(-15000)
      await this.clientSocket.stabilized()
      assert.equal(spy.callCount, 1)
    })

    it('should stop if the MPS is too small to send any money through', async function () {
      this.pluginA.maxAmount = 0
      const spy = sinon.spy(this.pluginA, 'sendData')
      this.clientSocket.setMinAndMaxBalance(-15000)
      await assert.isRejected(this.clientSocket.stabilized(), 'Cannot send through this path because the maximum packet amount appears to be zero')
      assert.equal(spy.callCount, 1)
    })

    it('should use the default behavior if the connector returns non-sensical data in the F08 error', async function () {
      this.pluginA.maxAmount = 800
      const spy = sinon.spy(this.pluginA, 'sendData')
      const realSendData = this.pluginA.sendData
      this.pluginA.sendData = async (data: Buffer) => {
        let result = await realSendData.call(this.pluginA, data)
        if (result[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
          result = IlpPacket.serializeIlpReject({
            ...IlpPacket.deserializeIlpReject(result),
            data: Buffer.from('xcoivusadlfkjlwkerjlkjlkxcjvlkoiuiowedr', 'base64')
          })
        }
        return result
      }

      this.clientSocket.setMinAndMaxBalance(-2000)
      await this.clientSocket.stabilized()
      assert.equal(spy.callCount, 5)
    })
  })

  describe('Error handling', function () {
    it('should emit an error and reject the stabilized Promise if it gets a reject with a final error code', async function () {
      const spy = sinon.spy()
      this.clientSocket.on('error', spy)

      const sendDataStub = sinon.stub(this.pluginA, 'sendData')
        .onSecondCall()
        .resolves(IlpPacket.serializeIlpReject({
          code: 'F00',
          message: 'Bad Request',
          data: Buffer.alloc(0),
          triggeredBy: 'test.connector'
        }))
        .callThrough()

      this.clientSocket.setMinAndMaxBalance(-2000)

      await assert.isRejected(this.clientSocket.stabilized(), 'Sending chunk failed with code: F00 and message: Bad Request')
      assert.equal(sendDataStub.callCount, 2)
      assert.equal(spy.callCount, 1)
    })

    it('should retry on temporary errors', async function () {
      const clock = lolex.install({
        toFake: ['setTimeout']
      })
      const interval = setInterval(() => clock.tick(1000))

      const spy = sinon.spy()
      this.clientSocket.on('error', spy)

      const sendDataStub = sinon.stub(this.pluginA, 'sendData')
        .onCall(0)
        .resolves(IlpPacket.serializeIlpReject({
          code: 'T00',
          message: 'Internal Server Error',
          data: Buffer.alloc(0),
          triggeredBy: 'test.connector'
        }))
        .onCall(1)
        .resolves(IlpPacket.serializeIlpReject({
          code: 'T01',
          message: 'Peer Unreachable',
          data: Buffer.alloc(0),
          triggeredBy: 'test.connector'
        }))
        .onCall(2)
        .resolves(IlpPacket.serializeIlpReject({
          code: 'T76',
          message: 'Some Other Temporary Error',
          data: Buffer.alloc(0),
          triggeredBy: 'test.connector'
        }))
        .callThrough()

      this.clientSocket.setMinAndMaxBalance(-1000)
      await this.clientSocket.stabilized()

      assert.equal(sendDataStub.callCount, 4)
      assert.equal(spy.callCount, 0)
      clock.uninstall()
      clearInterval(interval)
    })

    it.skip('should close the socket if it gets an unexpected error')
  })
})

describe('PaymentServer', function () {
  beforeEach(async function () {
    this.pluginA = new MockPlugin(0.5)
    this.pluginB = this.pluginA.mirror
    this.server = new PaymentServer({ plugin: this.pluginB })
  })

  describe('connect', function () {
    it('should connect the plugin', async function () {
      const spy = sinon.spy(this.pluginB, 'connect')
      await this.server.connect()
      assert(spy.called)
    })

    it('should reject connections for sockets that have been closed', async function () {
      await this.server.connect()
      const serverSocket = this.server.createSocket()

      await serverSocket.close()

      await assert.isRejected(createSocket({
        plugin: this.pluginA,
        sharedSecret: serverSocket.sharedSecret,
        destinationAccount: serverSocket.destinationAccount
      }), 'Peer closed connection')
    })
  })

  describe('disconnect', function () {
    beforeEach(async function () {
      await this.server.connect()
    })

    it('should disconnect the receiver and plugin', async function () {
      const spy = sinon.spy(this.pluginB, 'disconnect')
      await this.server.disconnect()
      assert(spy.called)
    })

    it('should disconnect all of the sockets', async function () {
      const closeSpy = sinon.spy()
      const socket1 = this.server.createSocket()
      const socket2 = this.server.createSocket()
      socket1.on('close', closeSpy)
      socket2.on('close', closeSpy)

      await this.server.disconnect()
      assert.equal(closeSpy.callCount, 2)
    })
  })

  describe('createSocket', function () {
    beforeEach(async function () {
      await this.server.connect()
    })

    it('should prepend the string "payment-socket:" to the shared secret', async function () {
      const prefix = 'payment-socket:'
      const { sharedSecret } = await this.server.createSocket()
      assert.equal(sharedSecret.slice(0, Buffer.from(prefix, 'utf8').length).toString('utf8'), prefix)
    })

    it('should default to minBalance and maxBalance of 0', async function () {
      const socket = await this.server.createSocket()
      assert.equal(socket.minBalance, '0')
      assert.equal(socket.maxBalance, '0')
    })
  })
})

describe('Client Socket (createSocket)', function () {
  beforeEach(async function () {
    this.pluginA = new MockPlugin(0.5)
    this.pluginB = this.pluginA.mirror
  })

  it('should use the same sharedSecret as the server', async function () {
    const server = await createServer({ plugin: this.pluginB })
    const { destinationAccount, sharedSecret } = server.createSocket()

    const clientSocket = await createSocket({
      plugin: this.pluginA,
      destinationAccount,
      sharedSecret
    })

    assert.deepEqual(sharedSecret, clientSocket.sharedSecret)
  })

  it('should default to minBalance and maxBalance of 0', async function () {
    const server = await createServer({ plugin: this.pluginB })
    const { destinationAccount, sharedSecret } = server.createSocket()

    const clientSocket = await createSocket({
      plugin: this.pluginA,
      destinationAccount,
      sharedSecret
    })

    assert.equal(clientSocket.minBalance, '0')
    assert.equal(clientSocket.maxBalance, '0')
  })

  it('should reject if it is given the details for an incompatible PSK2 receiver (not a Payment Socket Server)', async function () {
    const receiver = await PSK2.createReceiver({
      plugin: this.pluginB,
      requestHandler: (params: PSK2.RequestHandlerParams) => params.accept()
    })
    const { destinationAccount, sharedSecret } = receiver.generateAddressAndSecret()

    await assert.isRejected(createSocket({
      plugin: this.pluginA,
      destinationAccount,
      sharedSecret
    }), 'Shared secret and destination account are not for a Payment Socket (must start with "payment-socket:")')
  })
})
