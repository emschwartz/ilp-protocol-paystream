import 'mocha'
import { assert } from 'chai'
import { PaymentServer, createSocket, PaymentSocket } from '..'
import MockPlugin from './mocks/plugin'
import * as sinon from 'sinon'

describe('PaymentSocket', function () {
  beforeEach(async function () {
    this.pluginA = new MockPlugin(0.5)
    this.pluginB = this.pluginA.mirror

    this.server = new PaymentServer(this.pluginB, Buffer.alloc(32, '00', 'hex'))
    await this.server.connect()
    this.serverSocket = this.server.createSocket({
      enableRefunds: true
    })

    this.clientSocket = await createSocket({
      plugin: this.pluginA,
      destinationAccount: this.serverSocket.destinationAccount,
      sharedSecret: this.serverSocket.sharedSecret,
      enableRefunds: true
    })
  })

  afterEach(async function () {
    await this.server.disconnect()
    this.clientSocket.close()
  })

  describe('Events', function () {
    it('should emit "chunk" on every incoming or outgoing request', function (done) {
      const clientSpy = sinon.spy()
      const serverSpy = sinon.spy()
      this.clientSocket.on('chunk', () => {
        clientSpy()
        if (serverSpy.callCount === 2 && clientSpy.callCount === 2) {
          done()
        }
      })
      this.serverSocket.on('chunk', serverSpy)

      this.clientSocket.setMinAndMaxBalance(-2000)
    })
  })

  describe('Pushing money', function () {
    it('should send until the maximum balance is reached', function (done) {
      this.clientSocket.setMinAndMaxBalance(-2000)

      this.serverSocket.on('chunk', () => {
        if (this.serverSocket.balance === '1000') {
          done()
        }
      })
    })

    it('should allow you to send more by lowering the max balance further', function (done) {
      this.clientSocket.setMinAndMaxBalance(-1000)

      this.clientSocket.on('chunk', () => {
        if (this.clientSocket.balance === '-1000') {
          this.clientSocket.setMinAndMaxBalance(-3000)
        }
        if (this.serverSocket.balance === '1500') {
          done()
        }
      })
    })

    it.skip('should not go above the maxBalance of the other side', function (done) {
      this.clientSocket.setMinAndMaxBalance(-2000)
      this.serverSocket.setMaxBalance(1750)

      this.serverSocket.on('chunk', () => {
        if (this.serverSocket.balance === '1750') {
          done()
        }
      })
    })
  })

  describe('Pulling money', function () {
    it('should request money until the minimum balance is reached', function (done) {
      this.clientSocket.setMinAndMaxBalance(2000)
      this.serverSocket.setMinBalance(-4000)

      this.clientSocket.on('chunk', () => {
        if (this.clientSocket.balance === '2000') {
          done()
        }
      })
    })

    it('should allow you to request more money by lowering the minimum balance further', function (done) {
      this.serverSocket.setMinAndMaxBalance(1000)
      this.clientSocket.setMinBalance(-4000)

      this.clientSocket.on('chunk', () => {
        if (this.serverSocket.balance === '1000' && this.serverSocket.minBalance === '1000') {
          this.serverSocket.setMinAndMaxBalance(2000)
        }
        if (this.clientSocket.balance === '-2000') {
          done()
        }
      })
    })
  })
})
