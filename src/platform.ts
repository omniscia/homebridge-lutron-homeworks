import {API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic} from 'homebridge';
import {Configuration} from './Schemas/configuration';
import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {HomeworksAccessory, HomeworksLightAccessory, HomeworksShadeAccessory,
  HomeworksMotorShadeAccessory, HomeworksDmxLightAccessory} from './homeworksAccessory';
import {NetworkEngine} from './network';


export class HomeworksPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  private configuration: Configuration = {devices: [], apiPort: 23, host: '127.0.0.1', username: '', password: ''};
  private readonly engine: NetworkEngine;
  private readonly cachedPlatformAccessories: PlatformAccessory[] = [];
  private readonly homeworksAccessories: HomeworksAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.loadUserConfiguration();

    this.engine = new NetworkEngine(
      this.log,
      this.configuration.host,
      this.configuration.apiPort,
      this.configuration.username,
      this.configuration.password,
    );

    this.setupNetworkEngineCallbacks(this.engine);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('[Platform] didFinishLaunching:');
      this.discoverDevices();
      this.engine.connect();
    });
  }

  // <<<<<<<<<<<<<<<<[SETUP HELPERS]<<<<<<<<<<<<<<<<<
  /**
   * Loads and parses de user config.json for this platform
   */
  private loadUserConfiguration() {
    this.configuration = JSON.parse(JSON.stringify(this.config));
    this.log.debug('[Platform] User Configuration Loaded.');
    this.configuration.devices.forEach((device) => {
      this.log.debug('Device %s has %s integration ids', device.name, device.integrationIDs.length);
    });
  }


  // <<<<<<<<<<<<<<<<<<[NETWORKING]<<<<<<<<<<<<<<<<<<<
  /**
   * Register NetworkEngine Event Callbacks
   * Create callback for new message.
   * This callback will be called everytime we get a new msg from the processor (socket)
   */
  private setupNetworkEngineCallbacks(engine: NetworkEngine) {


    const rxCallback = (engine: NetworkEngine, message: string): void => {   //ON SOCKET TRAFFIC CALLBACK
      const messagesArray = message.split('\n');

      for (let singleMessage of messagesArray) {
        singleMessage = singleMessage.trim();

        if (singleMessage === '') {
          continue;
        }

        if (singleMessage.includes('~SYSTEM,6,')) { //This is considered a PONG reply.
          this.log.debug('[platform][Pong] Received'); //TODO: Move to NETWORK Class (why waste cycles here)
          continue;
        }

        if (!singleMessage.includes('GLINK_DEVICE_SERIAL_NUM') &&
          !singleMessage.includes('Device serial ')) {
          this.log.debug('[platform][traffic]', singleMessage);
        }

        //  Message format is (#?~)(COMMAND),(ID),(OP),(...)
        //  Normally we receive ~OUTPUT,(ID),1,(LEVEL)
        const splitMessage = singleMessage.split(',');  //Parse Message by splitting comas
        if (!splitMessage || splitMessage.length < 4) {
          this.log.info('[Platform][EngineCallback] unknown message %s', singleMessage);
          return;
        }

        const deviceId = splitMessage[1];
        const op = splitMessage[2];

        if (op !== '1' && op !== '32') {
          this.log.info('[Platform][EngineCallback] unknown operation %s', singleMessage);
          return;
        }

        const uuid = this.api.hap.uuid.generate(deviceId);
        const targetDevice = this.homeworksAccessories.find(accessory => accessory.getUUID() === uuid);
        if (!targetDevice) {
          return;
        }

        if (op === '1') {
          // Set level message from processor
          const level = Number(splitMessage[3]);
          this.log.debug('[Platform][EngineCallback] Set: %s to: %i', targetDevice.getName(), level);
          targetDevice.updateLevel(level);
        } else if (op === '32') {
          if (splitMessage.length !== 5) {
            this.log.info('[Platform][EngineCallback] message wrong length %s', singleMessage);
            return;
          }
          const action = splitMessage[3];

          if (action !== '2') {
            this.log.debug('[Platform][EngineCallback] unknown message action %s', singleMessage);
            return;
          }

          this.log.info('[Platform][EngineCallback] stopping %s', singleMessage);
          (targetDevice as HomeworksShadeAccessory).stopped();
        }
      }

    };

    // * Will be called eveytime we connect to the processor (socket)
    const connectedCallback = (engine: NetworkEngine): void => {
      //When we connect. We want to get the latest state for the lights. So we issue a query
      //  NOTE: If the device is being updated elsewhere (like another app or switch) this
      //  value may be incorrect
      for (const accessory of this.homeworksAccessories) {
        for (const integrationId of accessory.getIntegrationIds()) {
          this.log.debug('[Platform] Requesting level for:', accessory.getName());
          const command = `?OUTPUT,${integrationId},1`;
          engine.send(command);
        }
      }
    };

    // * Do register the callbacks in the network engine
    engine.registerReceiveCallback(rxCallback);
    engine.registerDidConnectCallback(connectedCallback);
  }

  // <<<<<<<<<<<<<<<<<<[Homebridge API]<<<<<<<<<<<<<<<<<<<
  /**
   * Delegate: Called when homebridge restores cached accessories from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.cachedPlatformAccessories.push(accessory);
  }

  /**
   * Register devices in HomeKit (When API finishes launching)
   */
  discoverDevices() {
    //TODO: Move elsewhere. 
    //This will be called when a request from HK comes to change a value in the processor
    const levelChangeCallback = (value, accessory: HomeworksAccessory): void => { //Callback from HK
      this.log.warn('Callback to update %s to %s', accessory.getIntegrationIds(), value);

      if (accessory instanceof HomeworksDmxLightAccessory) {
        this.engine.send(`#OUTPUT,${accessory.getIntegrationIds()[0]},17,"red"}`);
        this.engine.send(`#OUTPUT,${accessory.getIntegrationIds()[1]},17,"green"}`);
        this.engine.send(`#OUTPUT,${accessory.getIntegrationIds()[2]},17,"blue"}`);
        this.engine.send(`#OUTPUT,${accessory.getIntegrationIds()[3]},17,"white"}`);
      } else {
        accessory.getIntegrationIds().forEach((integrationId) => {
          let command: string;

          if (accessory instanceof HomeworksMotorShadeAccessory) {
            if (value > 67) {
              command = `#OUTPUT,${integrationId},2`;
            } else if (value < 34) {
              command = `#OUTPUT,${integrationId},3`;
            } else {
              command = `#OUTPUT,${integrationId},4`;
            }
          } else if (accessory instanceof HomeworksLightAccessory) {
            const fadeTime = accessory.getIsDimmable() ? '00:01' : '00:00';
            command = `#OUTPUT,${integrationId},1,${value},${fadeTime}`;
          } else {
            command = `#OUTPUT,${integrationId},1,${value}`;
          }

          accessory.updateLevel(value); //Shall we update it locally?

          this.log.debug('[Platform][setLutronCallback] %s to %s (%s)', accessory.getName(), value, command);
          this.engine.send(command);
        });
      }
    };

    //The following will iterate through the config file, check if the device is cached or updated.
    //And also check if we find a device that is no longer in HK but was. And issue a remove.
    const allAddedAccessories: PlatformAccessory[] = [];

    for (const confDevice of (this.configuration.devices || [])) {       //Iterate through the devices in config.

      if (typeof (confDevice.name) !== 'string' ) {
        this.log.error('[platform][Error] Unable to load accessory: %s [no name]');
      }

      if (!(Array.isArray(confDevice.integrationIDs) && confDevice.integrationIDs.length > 0
        && confDevice.integrationIDs.every(item => typeof (item) === 'string'))) {
        this.log.error('[platform][Error] Unable to load accessory: %s [incorrect ids]',
          confDevice.integrationIDs.toString());
      }

      if (typeof (confDevice.isDimmable) !== 'boolean') {
        this.log.error('[platform][Error] Unable to load accessory: %s [no dimmable boolean]',
          confDevice.integrationIDs.toString(), confDevice.isDimmable);
      }

      if (confDevice.deviceType !== 'light' && confDevice.deviceType !== 'shade' &&
          confDevice.deviceType !== 'motorshade' && confDevice.deviceType !== 'dmxlight') {
        this.log.error('[platform][Error] Unable to load accessory: %s [incorrect type: %s]',
          confDevice.integrationIDs.toString(), confDevice.deviceType);
      }

      const uuid = this.api.hap.uuid.generate(confDevice.integrationIDs.toString());
      let loadedAccessory = this.cachedPlatformAccessories.find(accessory => accessory.UUID === uuid);

      if (!loadedAccessory) {
        //  Device UUID not found in cache
        this.log.info('[Platform] + Creating:', confDevice.name);
        const accessory = new this.api.platformAccessory(confDevice.name, uuid);
        accessory.context.device = confDevice;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        loadedAccessory = accessory;
      } else {
        // device UUID found in cache
        this.log.info('[Platform] ~ Updating:', confDevice.name);
        loadedAccessory.context.device = confDevice;
        loadedAccessory.displayName = confDevice.name; // Will be updated unless changed in Homekit.
        this.api.updatePlatformAccessories([loadedAccessory]);
      }

      // Registering to platform
      let isDimmable = true;
      if (confDevice.isDimmable === false) {
        isDimmable = false;
        confDevice.isDimmable = isDimmable;
      }

      this.log.info('[Platform] Registering: %s as %s Dimmable: %s', loadedAccessory.displayName, confDevice.name, isDimmable);
      // eslint-disable-next-line max-len
      const hwa = HomeworksAccessory.CreateAccessory(this, loadedAccessory, loadedAccessory.UUID, confDevice);
      this.homeworksAccessories.push(hwa);
      hwa.lutronLevelChangeCallback = levelChangeCallback;
      allAddedAccessories.push(loadedAccessory);
    }

    const toDelete =
      this.difference(this.cachedPlatformAccessories, allAddedAccessories) as PlatformAccessory[];

    if (toDelete.length > 0) {
      this.log.warn('[platform] Removing: %i accesories', toDelete.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toDelete);
    }
  }

  //Helper function to get the difference in an array
  difference(a, b) {
    const setB = new Set(b);
    return [...new Set(a)].filter(x => !setB.has(x));
  }
}
