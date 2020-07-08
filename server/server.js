const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const config = require('./config');

// Global variables
// Worker de mediasoup
let worker;
// worker de mediasoup
let mediasoupRouter;

/*
  Router:
  Vamos a tener (excepto que pasen cosas malas) un router por llamada

  Transports:
  Vamos a tener 1 producer transport por client (n)
  Vamos a tener 1 consumer transport por client (n)

  Producers:
  Vamos a tener tantos producers como streams nos pasen los clients 
  Si tenemos n clients y cada client nos pasa audio y video, tenemos 2n producers

  Consumers:
  Vamos a tener tantos consumers como streams nos pidan los clients
  Si tenemos m producers y los consumen los n clients, tenemos
  m*n consumers. Si el client no quiere lo que produce, tenemos m*n - n*(1 o 2)
*/

/*
  Map of participants indexed by id. Each Object has:
  - {String} id
  - {Object} data
    - {String} displayName
    - {RTCRtpCapabilities} rtpCapabilities
    - {Map<String, mediasoup.Transport>} transports
    - {Map<String, mediasoup.Producer>} producers
    - {Map<String, mediasoup.Consumers>} consumers
  @type {Map<String, Object>}
*/
let participants = new Map();

// Server https
let webServer;

// Socket de socket-io
let socketServer;

// App del framework Express
let expressApp;


// Configuramos las cosas que debe hacer el programa y luego pasará todo con los callbacks que definamos
(async () => {
    try {
      // Creamos la app de express
      await runExpressApp();
      // Ponemos al server a escuchar
      await runWebServer();
      // Abrimos el socket y definimos que pasa ante los distintos eventos
      await runSocketServer();
      // Una vez listo todo, instanciamos mediasoup
      await runMediasoupWorker();
  
    } catch (err) {
      console.error(err);
    }
})();

async function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));

  expressApp.use((error, req, res, next) => {
    if (error) {
    console.warn('Express app error,', error.message);

    error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

    res.statusMessage = error.message;
    res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
}

async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    console.error('SSL files are not found. check your config.js file');
    process.exit(0);
  }
  const tls = {
    cert: fs.readFileSync(sslCrt),
    key: fs.readFileSync(sslKey),
  };
  webServer = https.createServer(tls, expressApp);
  webServer.on('error', (err) => {
    console.error('starting web server failed:', err.message);
  });

  await new Promise((resolve) => {
    const { listenIp, listenPort } = config;
    webServer.listen(listenPort, listenIp, () => {
      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      console.log('server is running');
      console.log(`open https://${ip}:${listenPort} in your web browser`);
      resolve();
    });
  });
}


async function runSocketServer() {
  socketServer = socketIO(webServer, {
    serveClient: false,
    // El client se conectará a address/server
    path: '/server',
    log: false,
  });

  // Todo esto pasará cuando el client se conecte al socket
  socketServer.on('connection', (socket) => {

    // inform the client about existence of producer
    if (producer) {
      socket.emit('newProducer');
    }

    socket.on('disconnect', () => {
      console.log('client disconnected');
    });

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      callback(mediasoupRouter.rtpCapabilities);
    });

    /**
     * Create Participant:
     * Se crea un nuevo participante de la reunion con sus correspondientes webRTCtransports
     * para producir y consumir streams
     * @param data: 
    */
    socket.on('createParticipant', async (data, callback) => {
      try {
        const { pId, participant, params } = await createParticipant(data);
        participants.set(pId, participant);
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    /**
     * Connect Transports:
     * Conecta los transports remotos de un Participant con los del server
     * @param data: 
    */
    socket.on('connectTransports', async (data, callback) => {
      await connectTransports(data);
      callback();
    });

    /**
    *  Produce
    * 
    */
    socket.on('produce', async (data, callback) => {
      // kind indica el tipo de comunicacion, audio o video
      const {kind, rtpParameters} = data;
      producer = await producerTransport.produce({ kind, rtpParameters });
      callback({ id: producer.id });

      // inform clients about new producer
      socket.broadcast.emit('newProducer');
    });

    socket.on('consume', async (data, callback) => {
      callback(await createConsumer(producer, data.rtpCapabilities));
    });

    socket.on('resume', async (data, callback) => {
      await consumer.resume();
      callback();
    });
  });
}

async function createParticipant(data) {

  return {
    id,
    participant,
    params: {

    }
  }
}

async function connectTransports(data) {
  await producerTransport.connect({ dtlsParameters: data.dtlsParameters });
  await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
}

async function runMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  mediasoupRouter = await worker.createRouter({ mediaCodecs });
}

async function createWebRtcTransport() {
  const {
    maxIncomingBitrate,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await mediasoupRouter.createWebRtcTransport({
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate,
  });
  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {
    }
  }
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    },
  };
}


async function createConsumer(producer, rtpCapabilities) {
  if (!mediasoupRouter.canConsume(
    {
      producerId: producer.id,
      rtpCapabilities,
    })
  ) {
    console.error('can not consume');
    return;
  }
  try {
    consumer = await consumerTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: producer.kind === 'video', // ?????
    });
  } catch (error) {
    console.error('consume failed', error);
    return;
  }

  if (consumer.type === 'simulcast') {
    await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
  }

  return {
    producerId: producer.id,
    id: consumer.id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    type: consumer.type,
    producerPaused: consumer.producerPaused
  };
}