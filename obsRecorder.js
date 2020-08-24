const path = require('path');
const { Subject } = require('rxjs');
const { first } = require('rxjs/operators');

const osn = require("obs-studio-node");
const { BrowserWindow } = require('electron');
const electron = require('electron');

let obsInitialized = false;
let scene = null;

const EOBSSettingsCategories = {
  General : 'General',
      Stream : 'Stream',
      Output : 'Output',
      Audio : 'Audio',
      Video : 'Video',
      Hotkeys : 'Hotkeys',
      Advanced : 'Advanced'
}

// Init the library, launch OBS Studio instance, configure it, set up sources and scene
function initialize(win) {
  if (obsInitialized) {
    console.warn("OBS is already initialized, skipping initialization.");
    return;
  }

  initOBS();
  configureOBS();
  scene = setupScene();
  setupSources(scene);
  obsInitialized = true;

  const perfStatTimer = setInterval(() => {
	  win.webContents.send("performanceStatistics", osn.NodeObs.OBS_API_getPerformanceStatistics());
  }, 1000);

  win.on('close', () => clearInterval(perfStatTimer));
}

function getSetting(cate) {
  console.log(electron.screen.getAllDisplays())
  return osn.NodeObs.OBS_settings_getSettings(cate.name).data;
}

function initOBS() {
  console.debug('Initializing OBS...');
  osn.NodeObs.IPC.host('obs-studio-node-example'); // Usually some UUIDs go there
  osn.NodeObs.SetWorkingDirectory(path.join(__dirname, 'node_modules', 'obs-studio-node'));

  const obsDataPath = path.join(__dirname, 'osn-data'); // OBS Studio configs and logs

  // Arguments: locale, path to directory where configuration and logs will be stored, your application version
  const initResult = osn.NodeObs.OBS_API_initAPI('en-US', obsDataPath, '1.0.0');

  if (initResult !== 0) {
    const errorReasons = {
      '-2': 'DirectX could not be found on your system. Please install the latest version of DirectX for your machine here <https://www.microsoft.com/en-us/download/details.aspx?id=35?> and try again.',
      '-5': 'Failed to initialize OBS. Your video drivers may be out of date, or Streamlabs OBS may not be supported on your system.',
    }

    const errorMessage = errorReasons[initResult.toString()] || `An unknown error #${initResult} was encountered while initializing OBS.`;

    console.error('OBS init failure', errorMessage);

    shutdown();

    throw Error(errorMessage);
  }

  osn.NodeObs.OBS_service_connectOutputSignals((signalInfo) => {
    signals.next(signalInfo);
  });

  console.debug('OBS initialized');
}

function configureOBS() {
  console.debug('配置 OBS');
  setSetting('Output', 'Mode', 'Simple');
  const availableEncoders = getAvailableValues('Output', 'Recording', 'RecEncoder');
  setSetting('Output', 'RecEncoder', availableEncoders.slice(-1)[0] || 'x264');
  setSetting('Output', 'FilePath', path.join(__dirname, 'osnData'));
  setSetting('Output', 'RecFormat', 'mp4');
  setSetting('Output', 'VBitrate', 10000); // 10 Mbps
  setSetting('Video', 'FPSCommon', 60);
  console.log('位置：' + path.join(__dirname, 'osnData'))
  console.debug('配置obs完成');
}

function showSourceInfo(name) {
  return scene.getItems().filter(item => {
    return name.id == item.source.name
  }).map(item => {
      let r = {name:item.source.name,width:item.source.width,height:item.source.height,x:item.position.x,y:item.position.y,visible:item.visible};
      console.log(r)
      return r;
  })
}

function getAllScene() {
  // 遍历 osn.Global.getOutputSource() 根据type判断 ESourceType === 3
  //console.log(scene)
  //console.log(scene.name)
  return new Array({name:scene.name,items:scene.getItems().map(function (item) {
      return item.source.name;
    })});
  // return new Array(scene);
}

function selectDisPlay(index) {
  const scene = osn.SceneFactory.fromName('test-scene');
  //console.log(scene.getItems().length)

  scene.getItems().map(item => {
    console.log('desktop======')
    console.log(item.source.name)
    // 删除
    if('desktop-video' === item.source.name){
      osn.InputFactory.fromName(item.source.name).release()
      item.remove();
    }
  })

  const videoSource = osn.InputFactory.create('monitor_capture', 'desktop-video');
  const { physicalWidth, physicalHeight, aspectRatio } = displayInfo(index.id);
  // Update source settings:
  let settings = videoSource.settings;

  // 这个参数修改使用哪个显示器,从0开始
  settings['monitor'] = parseInt(index.id)
  settings['width'] = physicalWidth;
  settings['height'] = physicalHeight;
  videoSource.update(settings);
  videoSource.save();

  const newitem = scene.add(videoSource);
  const outputWidth = 1920;
  const videoScaleFactor = physicalWidth / outputWidth;
  const outputHeight = Math.round(outputWidth / aspectRatio);
  setSetting('Video', 'Base', `${outputWidth}x${outputHeight}`);
  setSetting('Video', 'Output', `${outputWidth}x${outputHeight}`);
  newitem.scale = { x: 1.0/ videoScaleFactor, y: 1.0 / videoScaleFactor };
  newitem.moveBottom()

  scene.save()
  return scene;
}

function displayInfo(index) {
  const { screen } = require('electron');
  const primaryDisplay = index?screen.getAllDisplays()[index]:screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const { scaleFactor } = primaryDisplay;
  return {
    width,
    height,
    scaleFactor:    scaleFactor,
    aspectRatio:    width / height,
    physicalWidth:  width * scaleFactor,
    physicalHeight: height * scaleFactor,
  }
}

function getALlCameras() {
  const dummyInput = osn.InputFactory.create('dshow_input', 'video', {
    audio_device_id: 'does_not_exist',
    video_device_id: 'does_not_exist',
  });

  const cameraItems = dummyInput.properties.get('video_device_id').details.items;

  dummyInput.release();

  return cameraItems;
}

function getCameraSource() {
  console.debug('Try to start the camera...')

  // Setup input without initializing any device just to get list of available ones
  const dummyInput = osn.InputFactory.create('dshow_input', 'video', {
    audio_device_id: 'does_not_exist',
    video_device_id: 'does_not_exist',
  });

  const cameraItems = dummyInput.properties.get('video_device_id').details.items;

  dummyInput.release();

  if (cameraItems.length === 0) {
    console.debug('No camera found')
    return null;
  }

  const deviceId = cameraItems[0].value;
  cameraItems[0].selected = true;
  console.debug('cameraItems[0].name: ' + cameraItems[0].name);

  const obsCameraInput = osn.InputFactory.create('dshow_input', 'dshow_input', {
    video_device_id: deviceId,
  });

  // It's a hack to wait a bit until device become initialized (maximum for 1 second)
  // If you know proper way how to determine whether camera is working and how to subscribe for any events from it, create a pull request
  // See discussion at https://github.com/Envek/obs-studio-node-example/issues/10
  for (let i = 1; i <= 4; i++) {
    if (obsCameraInput.width === 0) {
      const waitMs = 100 * i;
      console.debug(`Waiting for ${waitMs}ms until camera get initialized.`);
      busySleep(waitMs); // We can't use async/await here
    }
  }

  /*if (obsCameraInput.width === 0) {
    console.debug(`Found camera "${cameraItems[0].name}" doesn't seem to work as its reported width is still zero.`);
    return null;
  }*/

  // 必要时更新配置:
  let settings = obsCameraInput.settings;
  console.debug('Camera settings:', obsCameraInput.settings);
  settings['width'] = 320;
  settings['height'] = 240;
  obsCameraInput.update(settings);
  obsCameraInput.save();

  return obsCameraInput;
}

function setupScene() {
  const videoSource = osn.InputFactory.create('monitor_capture', 'desktop-video');

  const { physicalWidth, physicalHeight, aspectRatio } = displayInfo();

  // Update source settings:
  let settings = videoSource.settings;

  // 这个参数修改使用哪个显示器,从0开始
  settings['monitor'] = 1
  settings['width'] = physicalWidth;
  settings['height'] = physicalHeight;
  videoSource.update(settings);
  videoSource.save();

  // Set output video size to 1920x1080
  const outputWidth = 1920;
  const outputHeight = Math.round(outputWidth / aspectRatio);
  setSetting('Video', 'Base', `${outputWidth}x${outputHeight}`);
  setSetting('Video', 'Output', `${outputWidth}x${outputHeight}`);
  const videoScaleFactor = physicalWidth / outputWidth;

  // A scene is necessary here to properly scale captured screen size to output video size
  const scene = osn.SceneFactory.create('test-scene');
  const sceneItem = scene.add(videoSource);
  sceneItem.scale = { x: 1.0/ videoScaleFactor, y: 1.0 / videoScaleFactor };

  // const cameraSource = getCameraSource()
  // if (cameraSource) {
  //   const cameraItem = scene.add(cameraSource)
  //   const cameraScaleFactor = 1.0 / (3.0 * cameraSource.width / outputWidth)
  //   cameraItem.scale = { x: cameraScaleFactor, y: cameraScaleFactor }
  //   cameraItem.position = {
  //     x: outputWidth - cameraSource.width * cameraScaleFactor - outputWidth / 10,
  //     y:outputHeight - cameraSource.height * cameraScaleFactor - outputHeight / 10
  //   }
  //   cameraItem.moveTop()
  // }
  return scene;
}

function setupSources() {
  const audioSource = osn.InputFactory.create('wasapi_output_capture', 'desktop-audio'); // 桌面音频
  const micSource = osn.InputFactory.create('wasapi_input_capture', 'mic-audio'); // 麦克风音频

  // Tell recorder to use this source (I'm not sure if this is the correct way to use the first argument `channel`)
  osn.Global.setOutputSource(1, scene);
  osn.Global.setOutputSource(2, audioSource);
  osn.Global.setOutputSource(3, micSource);
}

const displayId = 'display1';

function setupPreview(window, bounds) {
  osn.NodeObs.OBS_content_createSourcePreviewDisplay(
    window.getNativeWindowHandle(),
    scene.name, // or use camera source Id here
    displayId,
  );
  osn.NodeObs.OBS_content_setShouldDrawUI(displayId, false);
  osn.NodeObs.OBS_content_setPaddingSize(displayId, 0);
  // Match padding color with main window background color
  osn.NodeObs.OBS_content_setPaddingColor(displayId, 255, 255, 255);

  return resizePreview(bounds);
}

function resizePreview(bounds) {
  const { aspectRatio, scaleFactor } = displayInfo();
  const displayWidth = Math.floor(bounds.width);
  const displayHeight = Math.round(displayWidth / aspectRatio);
  const displayX = Math.floor(bounds.x);
  const displayY = Math.floor(bounds.y);

  osn.NodeObs.OBS_content_resizeDisplay(displayId, displayWidth * scaleFactor, displayHeight * scaleFactor);
  osn.NodeObs.OBS_content_moveDisplay(displayId, displayX * scaleFactor, displayY * scaleFactor);

  return { height: displayHeight }
}

async function start() {
  if (!obsInitialized) initialize();

  let signalInfo;

  console.debug('Starting recording...');
  osn.NodeObs.OBS_service_startRecording();

  // osn.NodeObs.OBS_service_startStreaming();

  console.debug('Started?');
  signalInfo = await getNextSignalInfo();

  if (signalInfo.signal === 'Stop') {
    throw Error(signalInfo.error);
  }

  console.debug('Started signalInfo.type:', signalInfo.type, '(expected: "recording")');
  console.debug('Started signalInfo.signal:', signalInfo.signal, '(expected: "start")');
  console.debug('Started!');
}

async function stop() {
  let signalInfo;

  console.debug('Stopping recording...');
  osn.NodeObs.OBS_service_stopRecording();
  // osn.NodeObs.OBS_service_stopStreaming(true);
  console.debug('Stopped?');

  signalInfo = await getNextSignalInfo();

  console.debug('On stop signalInfo.type:', signalInfo.type, '(expected: "recording")');
  console.debug('On stop signalInfo.signal:', signalInfo.signal, '(expected: "stopping")');

  signalInfo = await getNextSignalInfo();

  console.debug('After stop signalInfo.type:', signalInfo.type, '(expected: "recording")');
  console.debug('After stop signalInfo.signal:', signalInfo.signal, '(expected: "stop")');

  console.debug('Stopped!');
}

function shutdown() {
  if (!obsInitialized) {
    console.debug('OBS is already shut down!');
    return false;
  }

  console.debug('Shutting down OBS...');

  try {
    osn.NodeObs.OBS_service_removeCallback();
    osn.NodeObs.IPC.disconnect();
    obsInitialized = false;
  } catch(e) {
    throw Error('Exception when shutting down OBS process' + e);
  }

  console.debug('OBS shutdown successfully');

  return true;
}

function setSetting(category, parameter, value) {
  let oldValue;

  // Getting settings container
  const settings = osn.NodeObs.OBS_settings_getSettings(category).data;

  settings.forEach(subCategory => {
    subCategory.parameters.forEach(param => {
      if (param.name === parameter) {
        oldValue = param.currentValue;
        param.currentValue = value;
      }
    });
  });

  // Saving updated settings container
  if (value != oldValue) {
    osn.NodeObs.OBS_settings_saveSettings(category, settings);
  }
}

function getAvailableValues(category, subcategory, parameter) {
  const categorySettings = osn.NodeObs.OBS_settings_getSettings(category).data;

  if (!categorySettings) {
    console.warn(`There is no category ${category} in OBS settings`);
    return [];
  }

  const subcategorySettings = categorySettings.find(sub => sub.nameSubCategory === subcategory);
  if (!subcategorySettings) {
    console.warn(`There is no subcategory ${subcategory} for OBS settings category ${category}`);
    return [];
  }

  const parameterSettings = subcategorySettings.parameters.find(param => param.name === parameter);
  if (!parameterSettings) {
    console.warn(`There is no parameter ${parameter} for OBS settings category ${category}.${subcategory}`);
    return [];
  }

  return parameterSettings.values.map( value => Object.values(value)[0]);
}

const signals = new Subject();

function getNextSignalInfo() {
  return new Promise((resolve, reject) => {
    signals.pipe(first()).subscribe(signalInfo => resolve(signalInfo));
    setTimeout(() => reject('Output signal timeout'), 30000);
  });
}

function busySleep(sleepDuration) {
  var now = new Date().getTime();
  while(new Date().getTime() < now + sleepDuration) { /* do nothing */ };
}

module.exports.initialize = initialize;
module.exports.start = start;
module.exports.stop = stop;
module.exports.shutdown = shutdown;
module.exports.setupPreview = setupPreview;
module.exports.resizePreview = resizePreview;
module.exports.getSetting = getSetting;
module.exports.selectDisPlay = selectDisPlay;
module.exports.getALlCameras = getALlCameras;
module.exports.getAllScene = getAllScene;
module.exports.showSourceInfo = showSourceInfo;
