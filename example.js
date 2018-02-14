const { PaymentServer, createSocket } = require('.')
const IlpPluginBtp = require('ilp-plugin-btp')
const crypto = require('crypto')

async function run () {
  const receiverPlugin = new IlpPluginBtp({ server: 'btp+ws://:receiver@localhost:7768' })
  const server = new PaymentServer(receiverPlugin, crypto.randomBytes(32))
  await server.connect()
  const receiverSocket = server.createSocket()
  receiverSocket.setMaxBalance(4000)

  const senderPlugin = new IlpPluginBtp({ server: 'btp+ws://:sender@localhost:7768' })
  const senderSocket = await createSocket({
    plugin: senderPlugin,
    destinationAccount: receiverSocket.destinationAccount,
    sharedSecret: receiverSocket.sharedSecret
  })
  senderSocket.setMinAndMaxBalance(-5000)

  senderSocket.on('chunk', () => {
    if (senderSocket.balance === '-4000' && senderSocket.minBalance !== '0') {
      senderSocket.setMinAndMaxBalance(0)
    }
  }, 5000)
}

run().catch(err => console.log(err))
