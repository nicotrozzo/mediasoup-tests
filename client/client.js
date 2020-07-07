const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');

const hostname = window.location.hostname;

// Cada client tiene un Device de Mediasoup
let device;

// WebSocket de socket.io para conectarnos al socket del server
let socket;

// Cada client tiene 1 producer por stream (audio, video, screen sharing)
let producer;

let streamType;

const $ = document.querySelector.bind(document);
const $fsPublish = $('#fs_publish');
const $fsSubscribe = $('#fs_subscribe');
const $btnConnect = $('#btn_connect');
const $btnAudio = $('#btn_audio');
const $btnWebcam = $('#btn_webcam');
const $btnScreen = $('#btn_screen');
const $btnSubscribe = $('#btn_subscribe');
const $chkSimulcast = $('#chk_simulcast');
const $txtConnection = $('#connection_status');
const $txtAudio = $('#audio_status');
const $txtWebcam = $('#webcam_status');
const $txtScreen = $('#screen_status');
const $txtSubscription = $('#sub_status');
let $txtPublish;

$btnConnect.addEventListener('click', connect);
$btnAudio.addEventListener('click', publish);
$btnWebcam.addEventListener('click', publish);
$btnScreen.addEventListener('click', publish);
$btnSubscribe.addEventListener('click', subscribe);


if (typeof navigator.mediaDevices.getDisplayMedia === 'undefined') {
  $txtScreen.innerHTML = 'Not supported';
  $btnScreen.disabled = true;
}


async function connect() {
  $btnConnect.disabled = true;
  $txtConnection.innerHTML = 'Connecting...';

  const opts = {
    path: '/server',
    transports: ['websocket'],
  };

  const serverUrl = `https://${hostname}:${config.listenPort}`;
  socket = socketClient(serverUrl, opts);
  socket.request = socketPromise(socket);

  socket.on('connect', async () => {
    $txtConnection.innerHTML = 'Connected';
    $fsPublish.disabled = false;
    $fsSubscribe.disabled = true;

    const data = await socket.request('getRouterRtpCapabilities');
    await loadDevice(data);
  });

  socket.on('disconnect', () => {
    $txtConnection.innerHTML = 'Disconnected';
    $btnConnect.disabled = false;
    $fsPublish.disabled = true;
    $fsSubscribe.disabled = true;
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    $txtConnection.innerHTML = 'Connection failed';
    $btnConnect.disabled = false;
  });

  socket.on('newProducer', () => {
    $fsSubscribe.disabled = false;
    console.log('Nico avisa que hay newProducer');
  });
}


async function loadDevice(routerRtpCapabilities) {
  try {
    device = new mediasoup.Device();
  } catch (error) {
    if (error.name === 'UnsupportedError') {
      console.error('browser not supported');
    }
  }
  await device.load({ routerRtpCapabilities });
}

async function publish(e) {

  console.log("publish: ");
  streamType = e.target.id;
  switch (streamType) {
    case "btn_webcam":
      $txtPublish = $txtWebcam;
      break;
    case "btn_audio":
      $txtPublish = $txtAudio;
      break;
    case "btn_screen":
      $txtPublish = $txtScreen;
      break;
    default:
      break;
  }
  console.log("streamType: " + streamType);

  // Crea transport remoto para el producer
  const data = await socket.request('createProducerTransport', {
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });

  console.log("server created producer transport. Data: ", data);

  if (data.error) {
    console.error(data.error);
    return;
  }

  console.log("about to create send transport");
  // Crea transport local y lo conecta al remoto
  const transport = device.createSendTransport(data);

  console.log("created send transport");

  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    console.log("sendTransport onconnect");
    socket.request('connectProducerTransport', { dtlsParameters })
      .then(callback)
      .catch(errback);
  });

  // Al crear el producer local le dice al remoto que cree el producer correspondiente
  transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    console.log("sendTransport onproduce. Kind: ", kind);
    try {
      const { id } = await socket.request('produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });

  transport.on('connectionstatechange', (state) => {
    switch (state) {
      case 'connecting':
        $txtPublish.innerHTML = 'publishing...';
        $fsPublish.disabled = true;
        $fsSubscribe.disabled = true;
        console.log("publishing...");
      break;

      case 'connected':
        if(streamType === "btn_audio") {
          document.querySelector('#local_audio').textContent = "Ya publique el stream de audio papi";
        }
        else {
          document.querySelector('#local_video').srcObject = stream;
        }
        $txtPublish.innerHTML = 'published';
        $fsPublish.disabled = true;
        $fsSubscribe.disabled = false;
      break;

      case 'failed':
        transport.close();
        $txtPublish.innerHTML = 'failed transporting';
        $fsPublish.disabled = false;
        $fsSubscribe.disabled = true;
        console.log("failed");
      break;

      default: break;
    }
  });

  let stream;
  try {
    let track = null;
    console.log("about to getUserMedia");
    stream = await getUserMedia(transport, streamType);
    console.log("gotUserMedia");
    if(streamType === "btn_audio") {
      console.log("about to getAudioTracks");
      track = stream.getAudioTracks()[0];
    }
    else {
      console.log("about to getVideoTracks");
      track = stream.getVideoTracks()[0];
    }
    console.log("Got track: ", track, "about to produce");
    const params = { track };
    producer = await transport.produce(params);
    console.log("got producer!");
  } catch (err) {
    $txtPublish.innerHTML = 'failed getting user media';
    console.log(err);
  }
}

async function getUserMedia(transport, type) {
  let mediaType;
  if(type === "btn_audio") {
    mediaType = "audio";
  }
  else {
    mediaType = "video";
  }
  if (!device.canProduce(mediaType)) {
    console.error('cannot produce' + mediaType);
    return;
  }
  let stream;
  try {
    switch (type) {
      case "btn_webcam":
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
        break;
      case "btn_audio":
        $txtPublish = await navigator.mediaDevices.getUserMedia({ audio: true });
        break;
      case "btn_screen":
        $txtPublish = await navigator.mediaDevices.getDisplayMedia({ video: true });
        break;
      default:
        break;
    } 
  } catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }
  return stream;
}

async function subscribe() {
  const data = await socket.request('createConsumerTransport', {
    forceTcp: false,
  });
  if (data.error) {
    console.error(data.error);
    return;
  }

  const transport = device.createRecvTransport(data);
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.request('connectConsumerTransport', {
      transportId: transport.id,
      dtlsParameters
    })
      .then(callback)
      .catch(errback);
  });

  transport.on('connectionstatechange', async (state) => {
    switch (state) {
      case 'connecting':
        $txtSubscription.innerHTML = 'subscribing...';
        $fsSubscribe.disabled = true;
        break;

      case 'connected':
        if(streamType === "btn_audio") {
          console.log("aca se cga todo perroooo");
          document.querySelector('#remote_audio').srcObject = await stream;
        }
        else {
          document.querySelector('#remote_video').srcObject = await stream;
        }
        await socket.request('resume');
        $txtSubscription.innerHTML = 'subscribed';
        $fsSubscribe.disabled = true;
        break;

      case 'failed':
        transport.close();
        $txtSubscription.innerHTML = 'failed';
        $fsSubscribe.disabled = false;
        break;

      default: break;
    }
  });

  const stream = consume(transport);
}

async function consume(transport) {
  const { rtpCapabilities } = device;
  const data = await socket.request('consume', { rtpCapabilities });
  const {
    producerId,
    id,
    kind,
    rtpParameters,
  } = data;

  let codecOptions = {};
  const consumer = await transport.consume({
    id,
    producerId,
    kind,
    rtpParameters,
    codecOptions,
  });
  const stream = new MediaStream();
  stream.addTrack(consumer.track);
  return stream;
}
