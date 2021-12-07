
import "./lib/mediasoupclient.min.js";

// configuration
const serverKey = "jn98pfl663mngruo";
const serverName = "vtt.bazjaz.com";
const serverUrl = "https://vtt.bazjaz.com:3016";
const roomId = "32";

function zdebug0( obj ) {
  // console.log( obj );
}
function zdebug( obj ) {
  // console.log( obj );
}

const socketPromise = function( socket ) {
  return function request(type, data = {}) {
    return new Promise((resolve) => {
      socket.emit(type, data, resolve);
    });
  }
};

class zMediaSoupUser {
  constructor( user ) {
    this._user = user;
    this._streams = {};
  }

  userId() { return this._user.id; }
};

class zMediaSoupAVClient extends AVClient {
  constructor( master, settings ) {
    super( master, settings );
  }

  /* -------------------------------------------- */
  /*  Connection                                  */
  /* -------------------------------------------- */

  /**
     * One-time initialization actions that should be performed for this client implementation.
     * This will be called only once when the Game object is first set-up.
     * @return {Promise<void>}
     */
  async initialize() {
    zdebug0( "MediaSoup initialize" );
    this._server = serverName;
    this._roomId = roomId;
    this._socket = null;
    this._device = null;
    this._user = new zMediaSoupUser( game.user );
    this._users = {};
    this._users[ this._user.userId() ] = this._user;
    this._producerTransport = null;
    this._consumerTransport = null;

    // set client to always be on
    if ( this.settings.get("client", "voice.mode") === "activity" ) {
      this.settings.set( "client", "voice.mode", "always" );
    }
  }

  onVolumeChange( event ) {
    const input = event.currentTarget;
    const box = input.closest(".camera-view");
    const volume = AudioHelper.inputToVolume( input.value );
    box.getElementsByTagName("audio")[0].volume = volume;
  }

  getUserAudioElement( userId, videoElement = null ) {
    // Find an existing audio element
    let audioElement = ui.webrtc.element.find(`.camera-view[data-user=${userId}] audio.user-audio`)[0];

    // If one doesn't exist, create it
    if ( !audioElement && videoElement ) {
      audioElement = document.createElement("audio");
      audioElement.className = "user-audio";
      audioElement.autoplay = true;
      videoElement.after(audioElement);
	  
      // Bind volume control
      ui.webrtc.element.find(`.camera-view[data-user=${userId}] .webrtc-volume-slider`).change( this.onVolumeChange.bind(this) );
    }

    return audioElement;
  }

  async initProducerTransports() {
    if ( !this._device.canProduce( 'video' ) ) {
      ui.notifications.notify( "MediaSoup: device cannot produce video" );
      return;
    }

    zdebug( 'MediaSoup: init producers' );
    zdebug( this._device.rtpCapabilities );

    const data = await this._socket.request('createWebRtcTransport', {
      forceTcp: false,
      rtpCapabilities: this._device.rtpCapabilities
    });
    if (data.error) {
      console.error(data.error)
      return
    }

    this._producerTransport = this._device.createSendTransport(data)
    this._producerTransport.on(
      'connect',
      async function ({ dtlsParameters }, callback, errback) {
        this._socket
          .request('connectTransport', {
            dtlsParameters,
            transport_id: data.id
          })
          .then(callback)
          .catch(errback)
      }.bind(this)
    );

    this._producerTransport.on(
      'produce',
      async function ({ kind, rtpParameters }, callback, errback) {
        try {
          const { producer_id } = await this._socket.request('produce', {
            producerTransportId: this._producerTransport.id,
            kind,
            rtpParameters
          })
          callback({
            id: producer_id
          })
        } catch (err) {
          errback(err)
        }
      }.bind(this)
    )

    this._producerTransport.on(
      'connectionstatechange',
      function (state) {
        switch (state) {
        case 'connecting':
          break
        case 'connected':
          //localVideo.srcObject = stream
          break
        case 'failed':
          this._producerTransport.close()
          break
        default:
          break
        }
      }.bind(this)
    )
  }

  async initConsumerTransports() {
    const data = await this._socket.request('createWebRtcTransport', {
      forceTcp: false
    });
    if (data.error) {
      console.error(data.error)
      return
    }

    // only one needed
    this._consumerTransport = this._device.createRecvTransport(data)
    this._consumerTransport.on(
      'connect',
      function ({ dtlsParameters }, callback, errback) {
        this._socket
          .request('connectTransport', {
            transport_id: this._consumerTransport.id,
            dtlsParameters
          })
          .then(callback)
          .catch(errback)
      }.bind(this)
    );

    this._consumerTransport.on(
      'connectionstatechange',
      async function (state) {
        switch (state) {
        case 'connecting':
          break
        case 'connected':
          break
        case 'failed':
          this.consumerTransport.close()
          break
        default:
          break
        }
      }.bind(this)
    );
  }

  removeStream( userId, stream_id ) {
    zdebug0( `--> removeConsumer ${userId} ${stream_id}` );
    let user = this._users[ userId ];
    if ( !user ) {
      zdebug0( '  no user found for removeStream' );
      return;
    }
    let stream = user._streams[ stream_id ];
    if ( !stream ) {
      zdebug0( '  no stream found for removeStream' );
      return;
    }
    for ( let track of stream.stream.getVideoTracks() ) {
      zdebug0( '  stop video track' );
      track.stop();
    }
    for ( let track of stream.stream.getAudioTracks() ) {
      zdebug0( '  stop audio track' );
      track.stop();
    }
    delete user._streams[ stream_id ];

    // render
    this.master.render();
  }

  async addProducer( kind ) {
    let video = (kind === "video");
    let audio = (kind === "audio");

    let src = this.settings.get( "client", video ? "videoSrc" : "audioSrc" );
    let params = { deviceId: { ideal: src } };

    let stream = await navigator.mediaDevices.getUserMedia( { video: video?params:false, audio: audio?params:false } );
    let producer = await this._producerTransport.produce( { track: video ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0] } );

    this._user._streams[ producer.id ] = {
      producer: producer,
      stream: stream,
      kind: kind
    };

    producer.on(
      'transportclose', function () {
	this.removeStream( this._user.userId(), producer.id );
      }.bind(this)
    );

    producer.on(
      'close',function () {
	this.removeStream( this._user.userId(), producer.id );
      }.bind(this)
    );

    producer.on(
      'transportclose', function () {
	this.removeStream( this._user.userId(), producer.id );
      }.bind(this)
    );
  }

  async produce() {
    // create device
    let socket = this._socket;
    this._device = new mediasoupClient.Device();

    await socket.request( 'createRoom', { room_id: this._roomId } )
      .catch( (err) => {
	console.error( 'MediaSoup: create room error:' );
	console.error( err );
      });

    socket.request( 'join', {
      name: this._user.userId(),
      room_id: this._roomId
    }).then(
      async function( e ) {
	zdebug0( `--> joined room` );
	console.log( 'MediaSoup: joined room' );
	let routerRtpCapabilities = await socket.request( 'getRouterRtpCapabilities' );
	zdebug( routerRtpCapabilities );
	await this._device.load( { routerRtpCapabilities } );
	await this.initProducerTransports();
	await this.initConsumerTransports();
	socket.emit( 'getProducers' );
      }.bind( this )
    ).catch( (err) => {
      console.error( 'MediaSoup: join room error: ' );
      console.error( err );
    });

    await this.addProducer( 'video' );
    await this.addProducer( 'audio' );
    
    // render
    this.master.render();
  }

  async getConsumeStream( producerId ) {
    const { rtpCapabilities } = this._device
    const data = await this._socket.request('consume', {
      rtpCapabilities,
      consumerTransportId: this._consumerTransport.id, // might be
      producerId
    });
    zdebug0( `-> consume stream from ${data.name}` );
    const { id, kind, rtpParameters } = data
    let userId = data.name;

    let codecOptions = {}
    const consumer = await this._consumerTransport.consume({
      id,
      producerId,
      kind,
      rtpParameters,
      codecOptions
    })

    const stream = new MediaStream()
    stream.addTrack( consumer.track )

    return {
      consumer,
      stream,
      kind,
      userId
    }
  }

  async consume( producer_id ) {
    let data = await this.getConsumeStream( producer_id );
    zdebug( `--> consume ${data.kind} ${data.userId}` );

    // need to push into users
    let gameUser = game.users.get( data.userId );
    if ( gameUser ) {
      let user = this._users[ gameUser.id ];
      if ( !user ) {
	user = new zMediaSoupUser( gameUser );
	this._users[ user.userId() ] = user;
      }
      user = this._users[ gameUser.id ];
      user._streams[ data.consumer.id ] = {
	consumer: data.consumer,
	stream: data.stream,
	kind: data.kind
      };
    }

    data.consumer.on(
      'trackended',
      function () {
	this.removeStream( data.userId, data.consumer.id );
      }.bind(this)
    )

    data.consumer.on(
      'transportclose',
      function () {
	this.removeStream( data.userId, data.consumer.id );
      }.bind(this)
    )

    // render
    this.master.render();
  }

  /* -------------------------------------------- */

  /**
     * Connect to any servers or services needed in order to provide audio/video functionality.
     * Any parameters needed in order to establish the connection should be drawn from the settings
     * object.
     * This function should return a boolean for whether the connection attempt was successful.
     * @return {Promise<boolean>}   Was the connection attempt successful?
     */
  async connect() {
    console.log( '------> CONNECT <------' );
    zdebug0( "MediaSoup connect" );

    await this.disconnect(); // Disconnect first, just in case

    const opts = {
      path: `/${serverKey}`,
      transports: ['websocket']
    };
    socket = io( serverUrl, opts );
    socket.request = socketPromise( socket );

    socket.on('connect', async () => {
      this._socket = socket;
      zdebug0( '--> connected!' );
      await this.produce();
    });

    socket.on('consumerClosed', async ( { consumer_id } ) => {
      zdebug0( `--> consumerClosed ${consumer_id}` );
      let userId = null;
      for ( let [key, value] of Object.entries( this._users ) ) {
	if ( value._streams[ consumer_id ] ) {
	  userId = value.userId();
	}
      }
      if ( userId ) {
	this.removeStream( userId, consumer_id );
      } else {
	zdebug0( `  no user for consumer` );
      }
    });

    socket.on('disconnect', () => {
      this._socket = null;
      zdebug0( '--> disconnected!' );
    });
    
    socket.on('connect_error', async (err) => {
      this._socket = null;
      console.error( 'MediaSoup: server connect error!' );
      console.error( err );
    });

    socket.on(
      'newProducers',
      async function (data) {
	zdebug0( '--> newProducers' );
	for ( let { producer_id } of data ) {
	  await this.consume( producer_id );
	}
      }.bind(this)
    );

    return true;
  }

  /* -------------------------------------------- */

  /**
     * Disconnect from any servers or services which are used to provide audio/video functionality.
     * This function should return a boolean for whether a valid disconnection occurred.
     * @return {Promise<boolean>}   Did a disconnection occur?
     */
  async disconnect() {
    zdebug0("MediaSoup disconnect");
    if ( this._socket ) {
      this._consumerTransport.close();
      this._producerTransport.close();
      this._socket.off( 'disconnect' );
      this._socket.off( 'newProducers' );
      this._socket.off( 'consumerClosed' );
    }
    return true;
  }

  /* -------------------------------------------- */
  /*  Device Discovery                            */
  /* -------------------------------------------- */

  /**
     * Provide an Object of available audio sources which can be used by this implementation.
     * Each object key should be a device id and the key should be a human-readable label.
     * @return {Promise<{string: string}>}
     */
  async getAudioSinks() {
    zdebug0( 'MediaSoup: getAudioSinks' );
    return this._getSourcesOfType( "audiooutput" );
  }

  /* -------------------------------------------- */

  /**
     * Provide an Object of available audio sources which can be used by this implementation.
     * Each object key should be a device id and the key should be a human-readable label.
     * @return {Promise<{string: string}>}
     */
  async getAudioSources() {
    zdebug0( 'MediaSoup: getAudioSources' );
    return this._getSourcesOfType( "audioinput" );
  }

  /* -------------------------------------------- */

  /**
     * Provide an Object of available video sources which can be used by this implementation.
     * Each object key should be a device id and the key should be a human-readable label.
     * @return {Promise<{string: string}>}
     */
  async getVideoSources() {
    zdebug0( 'MediaSoup: getVideoSources' );
    return this._getSourcesOfType( "videoinput" );
  }

  async _getSourcesOfType( kind )  {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.reduce( (obj, device) => {
      if (device.kind === kind) {
        obj[device.deviceId] =
          device.label || getGame().i18n.localize("WEBRTC.UnknownDevice");
      }
      return obj;
    }, {});
  }

  /* -------------------------------------------- */
  /*  Track Manipulation                          */
  /* -------------------------------------------- */

  /**
     * Return an array of Foundry User IDs which are currently connected to A/V.
     * The current user should also be included as a connected user in addition to all peers.
     * @return {string[]}           The connected User IDs
     */
  getConnectedUsers() {
    if ( !this._users ) {
      return [];
    }
    zdebug0( 'MediaSoup: getConnectedUsers' );
    let connectedUsers = [];
    for ( let id of Object.keys( this._users ) ) {
      connectedUsers.push( id );
    }
    return connectedUsers;
  }

  /* -------------------------------------------- */

  /**
     * Provide a MediaStream instance for a given user ID
     * @param {string} userId        The User id
     * @return {MediaStream|null}    The MediaStream for the user, or null if the user does not have
     *                                one
     */
  getMediaStreamForUser() {
    zdebug0("MediaSoup: getMediaStreamForUser called but not used");
    return null;
  }

  /* -------------------------------------------- */

  /**
     * Is outbound audio enabled for the current user?
     * @return {boolean}
     */
  isAudioEnabled() {
    zdebug0( 'MediaSoup: isAudioEnabled' );
    for ( let [key, value] of Object.entries( this._user._streams ) ) {
      if ( value.kind === 'audio' ) {
	return !(value.stream.getAudioTracks()[0].muted);
      }
    }
    return false;
  }

  /* -------------------------------------------- */

  /**
     * Is outbound video enabled for the current user?
     * @return {boolean}
     */
  isVideoEnabled() {
    zdebug0( 'MediaSoup: isVideoEnabled' );
    for ( let [key, value] of Object.entries( this._user._streams ) ) {
      if ( value.kind === 'video' ) {
	return value.stream.getAudioTracks()[0].enabled;
      }
    }
    return false;
  }

  /* -------------------------------------------- */

  /**
     * Handle a request to enable or disable the outbound audio feed for the current game user.
     * @param {boolean} enable        Whether the outbound audio track should be enabled (true) or
     *                                  disabled (false)
     */
  async toggleAudio(enable) {
    zdebug0( `MediaSoup: Toggling audio: ${enable}` );
    for ( let [key, value] of Object.entries( this._user._streams ) ) {
      if ( value.kind === 'audio' ) {
	value.stream.getAudioTracks()[0].enabled = enable;
      }
    }
  }

  /* -------------------------------------------- */

  /**
     * Set whether the outbound audio feed for the current game user is actively broadcasting.
     * This can only be true if audio is enabled, but may be false if using push-to-talk or voice
     * activation modes.
     * @param {boolean} broadcast   Whether outbound audio should be sent to connected peers or not?
     */
  async toggleBroadcast(broadcast) {
    zdebug0( "MediaSoup: Toggling Broadcast audio" );
    zdebug0( broadcast );
  }

  /* -------------------------------------------- */

  /**
     * Handle a request to enable or disable the outbound video feed for the current game user.
     * @param {boolean} enable        Whether the outbound video track should be enabled (true) or
     *                                  disabled (false)
     */
  async toggleVideo(enable) {
    zdebug0( `MediaSoup: Toggling video: ${enable}` );
    for ( let [key, value] of Object.entries( this._user._streams ) ) {
      if ( value.kind === 'video' ) {
	value.stream.getVideoTracks()[0].enabled = enable;
      }
    }
  }

  /* -------------------------------------------- */

  /**
     * Set the Video Track for a given User ID to a provided VideoElement
     * @param {string} userId                   The User ID to set to the element
     * @param {HTMLVideoElement} videoElement   The HTMLVideoElement to which the video should be
     *                                            set
     */
  async setUserVideo(userId, videoElement) {
    zdebug0( `MediaSoup: setUserVideo for ${userId}` );

    let user = this._users[ userId ];
    if ( !user ) {
      console.log( `MediaSoup: no video for user ${userId}` );
      return;
    }

    // attach video
    for ( let [key, value] of Object.entries( user._streams ) ) {
      if ( value.kind === 'video' ) {
	videoElement.srcObject = value.stream;
	const event = new CustomEvent( "webrtcVideoSet", { detail: { userId }} );
	videoElement.dispatchEvent( event );
      }
    }

    if ( this._user.userId() == userId ) {
      return;
    }

    // attach audio
    for ( let [key, value] of Object.entries( user._streams ) ) {
      if ( value.kind === 'audio' ) {
	let audioElement = this.getUserAudioElement( userId, videoElement );
	audioElement.srcObject = value.stream;
	audioElement.volume = this.settings.getUser(userId).volume;
	audioElement.muted = this.settings.get("client", "muteAll");
      }
    }
  }

  muteAll() {
    const muted = this.settings.get("client", "muteAll");
    for ( const userId of Object.keys( this._users ) ) {
      if ( userId === this._user.userId() ) {
	continue;
      }
      const audioElement = this.getUserAudioElement( userId );
      if ( audioElement ) {
        audioElement.muted = muted;
      }
    }
  }

  /* -------------------------------------------- */
  /*  Settings and Configuration                  */
  /* -------------------------------------------- */

  /**
     * Handle changes to A/V configuration settings.
     * @param {object} changed      The settings which have changed
     */
  onSettingsChanged(changed) {
    zdebug0( "MediaSoup: onSettingsChanged" );

    const keys = Object.keys(flattenObject(changed));

    // Change audio or video sources
    if (keys.some((k) => ["client.videoSrc", "client.audioSrc"].includes(k))
	|| hasProperty(changed, `users.${game.user.id}.canBroadcastVideo`)
	|| hasProperty(changed, `users.${game.user.id}.canBroadcastAudio`)) {
      this.master.connect();
    }

    // Change voice broadcasting mode
    if (keys.some((k) => ["client.voice.mode"].includes(k))) {
      this.master.connect();
    }

    // Change audio sink device
    if (keys.some((k) => ["client.audioSink"].includes(k))) {
      this.master.connect();
    }

    // Change muteAll
    if (keys.some((k) => ["client.muteAll"].includes(k))) {
      this.muteAll();
    }

    // render
    // this.master.render();
  }
}

// add reconnect button
Hooks.on( "renderCameraViews", async function( cameraviews, html ) {
  const cameraBox = html.find( `[data-user="${game.user?.id}"]` );
  const element = cameraBox.find( '[data-action="toggle-popout"]' );
  const connect = $('<a class="av-control" title="Reconnect"><i class="fas fa-sync"></i></a>');
  connect.on( "click", async () => { await game.webrtc.client.connect(); } );
  element.after( connect );
});

CONFIG.WebRTC.clientClass = zMediaSoupAVClient;
