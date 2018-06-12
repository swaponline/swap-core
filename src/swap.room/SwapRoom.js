import SwapApp, { Events, ServiceInterface } from 'swap.app'


class SwapRoom extends ServiceInterface {

  static get name() {
    return 'room'
  }

  constructor(config) {
    super()

    if (!config || typeof config !== 'object') {
      throw new Error('SwapRoomService: "config" of type object required')
    }

    this._serviceName   = 'room'
    this._events        = new Events()
    this._config        = config
    this.peer           = null
  }

  initService() {
    if (!SwapApp.env.Ipfs) {
      throw new Error('SwapRoomService: Ipfs required')
    }
    if (!SwapApp.env.IpfsRoom) {
      throw new Error('SwapRoomService: IpfsRoom required')
    }

    const ipfs = new SwapApp.env.Ipfs(this._config)

    ipfs.once('error', (err) => {
      console.log('IPFS error!', err)
    })

    ipfs.once('ready', () => ipfs.id((err, info) => {
      console.info('IPFS ready!', info)

      if (err) {
        throw err
      }

      this._init({
        peer: info.id,
        ipfsConnection: ipfs,
      })
    }))
  }

  _init({ peer, ipfsConnection }) {
    this.peer = peer

    this.connection = SwapApp.env.IpfsRoom(ipfsConnection, 'swap.online', {
      pollInterval: 5000,
    })

    this.connection.on('peer joined', this._handleUserOnline)
    this.connection.on('peer left', this._handleUserOffline)
    this.connection.on('message', this._handleNewMessage)

    this._events.dispatch('ready')
  }

  _handleUserOnline = (peer) => {
    if (peer !== this.peer) {
      this._events.dispatch('user online', peer)
    }
  }

  _handleUserOffline = (peer) => {
    if (peer !== this.peer) {
      this._events.dispatch('user offline', peer)
    }
  }

  _handleNewMessage = (message) => {
    if (message.from === this.peer) {
      return
    }

    const data = JSON.parse(message.data.toString())

    if (data && data.length) {
      data.forEach(({ event, data }) => {
        this._events.dispatch(event, { ...(data || {}), fromPeer: message.from })
      })
    }
  }

  subscribe(eventName, handler) {
    this._events.subscribe(eventName, handler)
  }

  unsubscribe(eventName, handler) {
    this._events.unsubscribe(eventName, handler)
  }

  once(eventName, handler) {
    this._events.once(eventName, handler)
  }

  sendMessage(...args) {
    if (args.length === 1) {
      const [ message ] = args

      this.connection.broadcast(JSON.stringify(message))
    }
    else {
      const [ peer, message ] = args

      this.connection.sendTo(peer, JSON.stringify(message))
    }
  }
}


export default SwapRoom
