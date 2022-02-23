
import "./lib/mediasoupclient.min.js";

import {position} from "./position.js";


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
  name()   { return this._user.name; }

  getStream( type ) {
    for ( let [key, value] of Object.entries( this._streams ) ) {
      if ( value.kind === type ) {
	return value.stream;
      }
    }
    return null;
  }
};

class zMediaSoupAVClient extends AVClient {
  constructor( master, settings ) {
    super( master, settings );
  }

  async sleep( delay ) {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  masterRender() {
    debounce( this.master.render(), 500 );
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
    zdebug( "--> MediaSoup initialize" );
    this._connected = false;
    this._serverKey = null;
    this._serverUrl = null;
    this._roomId = game.settings.get( "zmediasoup", "serverRoom");
    this._socket = null;
    this._device = null;
    this._user = new zMediaSoupUser( game.user );
    this._users = {};
    this._users[ this._user.userId() ] = this._user;
    this._producerTransport = null;
    this._consumerTransport = null;

    // set client to always be on
    this.settings.set( "client", "voice.mode", "always" );
  }

  get isVoicePTT() {
    return false;
  }
  get isVoiceAlways() {
    return true;
  }
  get isVoiceActivated() {
    return false;
  }
  get isMuted() {
    return this.settings.client.users[game.user?.id || ""]?.muted || false;
  }

  onVolumeChange( event ) {
    const input = event.currentTarget;
    const box = input.closest(".camera-view");
    const volume = AudioHelper.inputToVolume( input.value );
    box.getElementsByTagName("audio")[0].volume = volume;
  }

  async getUserAudioElement( userId, videoElement = null ) {
    // Find an existing audio element
    let audioElement = ui.webrtc.element.find(`.camera-view[data-user=${userId}] audio.user-audio`)[0];

    // If one doesn't exist, create it
    if ( !audioElement && videoElement ) {
      zdebug( `--------> create audio element ${this._users[userId].name()}` );

      audioElement = document.createElement("audio");
      audioElement.className = "user-audio";
      audioElement.autoplay = true;
      videoElement.after(audioElement);

      const requestedSink = this.settings.get( "client", "audioSink" );
      await audioElement.setSinkId( requestedSink ).catch(
	(error) => {
	  console.log( `Error setting audio sink: ${error}` );
	});
	  
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

    zdebug( '--> MediaSoup: init producers' );

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
    let user = this._users[ userId ];
    if ( !user ) {
      zdebug( '  no user found for removeStream' );
      return;
    }
    zdebug( `--> removeStream ${user.name()} ${stream_id}` );
    let stream = user._streams[ stream_id ];
    if ( !stream ) {
      zdebug( '  no stream found for removeStream' );
      return;
    }
    for ( let track of stream.stream.getVideoTracks() ) {
      zdebug( '  stop video track' );
      track.stop();
    }
    for ( let track of stream.stream.getAudioTracks() ) {
      zdebug( '  stop audio track' );
      track.stop();
    }
    delete user._streams[ stream_id ];

    // render
    this.masterRender();
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
	this.socket.emit( 'producerClosed', { producer_id: producer.id } );
      }.bind(this)
    );

    producer.on(
      'close',function () {
	this.removeStream( this._user.userId(), producer.id );
	this.socket.emit( 'producerClosed', { producer_id: producer.id } );
      }.bind(this)
    );

    producer.on(
      'transportclose', function () {
	this.removeStream( this._user.userId(), producer.id );
	this.socket.emit( 'producerClosed', { producer_id: producer.id } );
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
      userid: this._user.userId(),
      name: this._user.name(),
      room_id: this._roomId
    }).then(
      async function( e ) {
	zdebug( `--> joined room` );
	let routerRtpCapabilities = await socket.request( 'getRouterRtpCapabilities' );
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
    this.masterRender();
    await this.sleep( 1000 );

    // broadcast
    let activity = {av: { muted: !this.isAudioEnabled(), hidden: !this.isVideoEnabled } };
    console.log( `----> broadcast activity { muted: ${activity.av.muted}, hidden: ${activity.av.hidden} }` );
    game.user.broadcastActivity( activity );
  }

  async getConsumeStream( producerId ) {
    const { rtpCapabilities } = this._device
    const data = await this._socket.request('consume', {
      rtpCapabilities,
      consumerTransportId: this._consumerTransport.id, // might be
      producerId
    });
    zdebug( `--> consume stream from ${data.name}` );
    const { id, kind, rtpParameters } = data
    let userId = data.userid;

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
    // this.masterRender();
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
    if ( this._connected ) {
      console.log( '---> Mediasoup: ALREADY CONNECTED' );
      return true;
    }

    console.log( '---> Mediasoup: CONNECT' );

    // await this.disconnect(); // Disconnect first, just in case

    this._serverKey = game.settings.get( "zmediasoup", "serverKey" );
    this._serverUrl = game.settings.get( "zmediasoup", "serverUrl" );
    const opts = {
      path: `/${this._serverKey}`,
      transports: ['websocket']
    };
    socket = io( this._serverUrl, opts );
    socket.request = socketPromise( socket );

    socket.on('connect', async () => {
      this._socket = socket;
      zdebug( '--> connected!' );
      await this.produce();
    });

    socket.on('consumerClosed', async ( { consumer_id } ) => {
      zdebug( `--> consumerClosed ${consumer_id}` );
      let userId = null;
      for ( let [key, value] of Object.entries( this._users ) ) {
	if ( value._streams[ consumer_id ] ) {
	  userId = value.userId();
	}
      }
      if ( userId ) {
	this.removeStream( userId, consumer_id );
      } else {
	zdebug( `  no user for consumer` );
      }
      this.masterRender();
    });

    socket.on('disconnect', () => {
      this._socket = null;
      zdebug( '--> disconnected!' );
    });
    
    socket.on('connect_error', async (err) => {
      this._socket = null;
      console.error( 'MediaSoup: server connect error!' );
      console.error( err );
    });

    socket.on(
      'newProducers',
      async function (data) {
	zdebug( '--> newProducers' );
	for ( let { producer_id } of data ) {
	  await this.consume( producer_id );
	}
	this.masterRender();
      }.bind(this)
    );

    this._connected = true;
    return true;
  }

  /* -------------------------------------------- */

  /**
     * Disconnect from any servers or services which are used to provide audio/video functionality.
     * This function should return a boolean for whether a valid disconnection occurred.
     * @return {Promise<boolean>}   Did a disconnection occur?
     */
  async disconnect() {
    zdebug("--> MediaSoup disconnect");
    if ( this._connected && this._socket ) {
      this._connected = false;
      this._consumerTransport.close();
      this._producerTransport.close();
      this._socket.off( 'disconnect' );
      this._socket.off( 'newProducers' );
      this._socket.off( 'consumerClosed' );
    }
    return true;
  }

  async reconnect() {
    this.disconnect();
    await this.sleep( 1500 );
    this.connect();
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
    zdebug( '--> MediaSoup: getConnectedUsers' );
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
  getMediaStreamForUser( userId ) {
    zdebug(`--> MediaSoup: getMediaStreamForUser called for ${userId} but not used`);
    return null;
  }

  getLevelsStreamForUser( userId ) {
    zdebug(`--> MediaSoup: getLevelsStreamForUser called for ${userId} but not used`);
    return null;
  }

  async updateLocalStream() {
    zdebug(`--> MediaSoup: updateLocalStream called but not used`);
  }

  /* -------------------------------------------- */

  /**
     * Is outbound audio enabled for the current user?
     * @return {boolean}
     */
  isAudioEnabled() {
    if ( !this._connected ) {
      return false;
    }
    let stream = this._user.getStream( 'audio' );
    if ( stream ) {
      // zdebug( `--> MediaSoup: isAudioEnabled true` );
      return true;
    }
    // zdebug( '--> MediaSoup: isAudioEnabled false' );
    return false;
  }

  /* -------------------------------------------- */

  /**
     * Is outbound video enabled for the current user?
     * @return {boolean}
     */
  isVideoEnabled() {
    if ( !this._connected ) {
      return false;
    }
    let stream = this._user.getStream( 'video' );
    if ( stream ) {
      // zdebug( `--> MediaSoup: isVideoEnabled true` );
      return true;
    }
    // zdebug( '--> MediaSoup: isVideoEnabled false' );
    return false;
  }

  /* -------------------------------------------- */

  /**
     * Handle a request to enable or disable the outbound audio feed for the current game user.
     * @param {boolean} enable        Whether the outbound audio track should be enabled (true) or
     *                                  disabled (false)
     */
  async toggleAudio(enable) {
    zdebug( `--> MediaSoup: Toggling audio: ${enable}` );
    let stream = this._user.getStream( 'audio' );
    if ( stream ) {
      stream.getAudioTracks()[0].enabled = enable;
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
    zdebug( "--> MediaSoup: Toggling Broadcast audio" );
    zdebug( broadcast );
  }

  /* -------------------------------------------- */

  /**
     * Handle a request to enable or disable the outbound video feed for the current game user.
     * @param {boolean} enable        Whether the outbound video track should be enabled (true) or
     *                                  disabled (false)
     */
  async toggleVideo(enable) {
    zdebug( `--> MediaSoup: Toggling video: ${enable}` );
    // game.user.broadcastActivity( {av: { hidden: !enable } } );
    let stream = this._user.getStream( 'video' );
    if ( stream ) {
      stream.getVideoTracks()[0].enabled = enable;
    }
    this.masterRender();
  }

  /* -------------------------------------------- */

  /**
     * Set the Video Track for a given User ID to a provided VideoElement
     * @param {string} userId                   The User ID to set to the element
     * @param {HTMLVideoElement} videoElement   The HTMLVideoElement to which the video should be
     *                                            set
     */
  async setUserVideo(userId, videoElement) {
    zdebug( `--> MediaSoup: setUserVideo for ${userId}` );

    let user = this._users[ userId ];
    if ( !user ) {
      console.log( `MediaSoup: no video for user ${userId}` );
      return;
    }

    // attach video
    let video = user.getStream( 'video' );
    if ( video ) {
      videoElement.srcObject = video;
      const event = new CustomEvent( "webrtcVideoSet", { detail: { userId }} );
      await videoElement.dispatchEvent( event );
    }

    // if current user, done - do not attach audio
    if ( userId === game.user.id ) {
      return;
    }

    // attach audio
    let audio = user.getStream( 'audio' );
    if ( audio ) {
      let audioElement = await this.getUserAudioElement( userId, videoElement );
      audioElement.srcObject = audio;
      audioElement.volume = this.settings.getUser(userId).volume;
      audioElement.muted = this.settings.get("client", "muteAll");
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
    zdebug( "--> MediaSoup: onSettingsChanged" );

    // check settings
    const keys = new Set(Object.keys(foundry.utils.flattenObject(changed)));

    // Change audio source
    const audioSourceChange = keys.has("client.audioSrc");

    // Change video source
    const videoSourceChange = keys.has("client.videoSrc");

    // Re-render the AV camera view
    const renderChange = ["client.audioSink", "client.muteAll"].some((k) =>
      keys.has(k)
    );

    // check server
    console.log( `ROOM: ${this._roomId} -> ${game.settings.get( "zmediasoup", "serverRoom" )}` );
    console.log( `KEY:  ${this._serverKey} -> ${game.settings.get( "zmediasoup", "serverKey" )}` );
    console.log( `URL:  ${this._serverUrl} -> ${game.settings.get( "zmediasoup", "serverUrl" )}` );
    const serverChange = ( (this._roomId != game.settings.get( "zmediasoup", "serverRoom" )) ||
			   (this._serverKey != game.settings.get( "zmediasoup", "serverKey" )) ||
			   (this._serverUrl != game.settings.get( "zmediasoup", "serverUrl" )) );

    if ( serverChange || audioSourceChange || videoSourceChange || renderChange) {
      zdebug( '---> MediaSoup render' );
      this.disconnect();
      this.connect();
      this.masterRender();
    }
  }
}

// add reconnect button
/*
Hooks.on( "renderCameraViews", async function( cameraviews, html ) {
  const cameraBox = html.find( `[data-user="${game.user?.id}"]` );
  const element = cameraBox.find( '[data-action="toggle-popout"]' );
  const connect = $('<a class="av-control" title="Reconnect"><i class="fas fa-sync"></i></a>');
  connect.on( "click", async () => { await game.webrtc.client.connect(); } );
  element.after( connect );
});
*/

Hooks.once( "init", function() {
  game.settings.register( "zmediasoup", "serverKey", {
    name: "Server Key",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register( "zmediasoup", "serverUrl", {
    name: "Server Url",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register( "zmediasoup", "serverRoom", {
    name: "Server Room",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  position.init();
});

Hooks.on( "closeSettingsConfig", function( settings ) {
  if ( ui.webrtc ) {
    if ( ui.webrtc.settings ) {
      ui.webrtc.settings.client.onSettingsChanged( {} );
    }
  }
});

CONFIG.WebRTC.clientClass = zMediaSoupAVClient;
