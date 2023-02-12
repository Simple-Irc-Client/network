import { Server } from 'socket.io'
import { port } from './config'
import { handleEvents } from './events'
import { ircClient } from './irc'
import { IrcCommand } from './types'

console.log(`websocket port: ${port}`)
export const sicServerSocket = new Server(port, { path: '/SimpleIrcClient', cors: { origin: '*' } })
sicServerSocket.setMaxListeners(1)

const onClientEvent = (data: any): void => {
  handleEvents(ircClient, data)
}

sicServerSocket.on('connection', (socket) => {
  console.log(`connection ${socket.id} - ${new Date().toISOString()}`)

  socket.onAny((eventName, ...args) => {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    console.log(`${new Date().toISOString()} onAny: ${eventName} ${JSON.stringify(args)}`) // TODO debug
  })

  socket.on('sic-client-event', onClientEvent)

  socket.on('disconnect', () => {
    handleEvents(ircClient, { type: IrcCommand.disconnect })
    socket.removeListener('sic-client-event', onClientEvent)
  })
})
