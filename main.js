var _ = require('lodash');
var LocalCollection = require('./lib/minimongo.js');
var io = require('socket.io-client');
var ss = require('socket.io-stream');
var murmur = require('murmurhash-js');
var cookie = require('./lib/cookie.js');
var hyperstore_utils = require('./lib/hyperstore_utils.js');
var mongoMatcher = require('hyperyun-mongomatcher');
var permissionCode = new (require('./permissionCode/permissionCode.js'));
var validator = require('validator');

var init = function () { 

if(!Hyperyun) var Hyperyun = {};

Hyperyun.COMPANY_DOMAIN = "hyperyun.com";

// Hyperyun Version (don't move or change that line). 
Hyperyun._version = require('./package.json').version;

// Get Client information for Logger (and analytics?)     
Hyperyun._clientInfo = {
  hyperyun_version: Hyperyun._version
};

if(typeof window != "undefined") {
  if(window.screen) {
    Hyperyun._clientInfo.client = 'browser';
    Hyperyun._clientInfo.screen = {};
    if(window.screen.height) Hyperyun._clientInfo.screen.height = window.screen.height;
    if(window.screen.width) Hyperyun._clientInfo.screen.width = window.screen.width;
  }
  if(window.location) {
    if(window.location.origin) Hyperyun._clientInfo.location = {
      origin: window.location.origin
    };
  }
  if(window.navigator) {
    Hyperyun._clientInfo.navigator = {}
    if(window.navigator.userAgent) Hyperyun._clientInfo.navigator.userAgent= window.navigator.userAgent;
    if(window.navigator.language) Hyperyun._clientInfo.navigator.language = window.navigator.language || window.navigator.userLanguage;    
  }
}

if(typeof process != "undefined") {
  if(process.version) {
    Hyperyun._clientInfo.version = process.version;
    Hyperyun._clientInfo.client = 'nodejs';
  }
  if(process.versions)
    Hyperyun._clientInfo.versions = process.versions;
  if(process.platform)
    Hyperyun._clientInfo.platform = process.platform;
}
/***
 *    ██╗      ██████╗  ██████╗  ██████╗ ███████╗██████╗ 
 *    ██║     ██╔═══██╗██╔════╝ ██╔════╝ ██╔════╝██╔══██╗
 *    ██║     ██║   ██║██║  ███╗██║  ███╗█████╗  ██████╔╝
 *    ██║     ██║   ██║██║   ██║██║   ██║██╔══╝  ██╔══██╗
 *    ███████╗╚██████╔╝╚██████╔╝╚██████╔╝███████╗██║  ██║
 *    ╚══════╝ ╚═════╝  ╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝
 *                                                       
 */
Hyperyun.Logger = {
  _session_id: null,
  _unsentLogs: [],
  _logs: [],
  config: {
    track: {
      'Error': true,
      'EvalError': true,
      'InternalError': true,
      'RangeError': true,
      'ReferenceError': true,
      'SyntaxError': true,
      'TypeError': true,
      'URIError': true,
      'window': true,
      'node': false,
      'console': {
        'log': false,
        'error': false,
        'warn': false,
        'info': false
      }
    },
    loggerConsole: true
  }
};

Hyperyun.Logger.handleError = function(msg, url, line, type){
    if(!msg) msg = null;
    if(!url) url = null;
    if(!line) line = null;
    if(!type) if(msg) {
        type = Hyperyun.Logger.identifyError(msg);
    }
    Hyperyun.Logger.sendLog({message: msg, file: url, lineNumber: line, severity: type});
}

Hyperyun.Logger.sendLog = function(log){
    Hyperyun.Logger._logs.push(log);
    if(Hyperyun.Hyperstore &&  Hyperyun.Hyperstore.hyperyunLogs && Hyperyun.Logger._session_id) {
        Hyperyun.Hyperstore.hyperyunLogs.update({_id: Hyperyun.Logger._session_id}, {"$push":{logs:log}});
    } else {
        Hyperyun.Logger._unsentLogs.push(log);
    }  
}

Hyperyun.Logger.identifyError = function(msg){
    var knownTypes = ['EvalError', 'InternalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'Error'];
    for (var i = 0; i < knownTypes.length; i++) {
        if(msg.search(knownTypes[i]) >= 0) return knownTypes[i];
    };
    return 'Unknown Error';
}

if(typeof window != "undefined" && (typeof disableHyperyunLogger == "undefined" || !disableHyperyunLogger)) {
  Hyperyun.Logger.Bugsnag = require('./lib/logger.js');
}

if(typeof process != "undefined" && process.on && (typeof disableHyperyunLogger == "undefined" || !disableHyperyunLogger)) {
  process.on('uncaughtException', function(error) {
    if(Hyperyun.Logger.config.track.process) {
      Hyperyun.Logger.handleError(error.stack, null, null, Hyperyun.Logger.identifyError(error.toString()), function() {
        throw error;
      });
    }
  });
}
/***
 *     █████╗ ███╗   ██╗ █████╗ ██╗  ██╗   ██╗████████╗██╗ ██████╗███████╗
 *    ██╔══██╗████╗  ██║██╔══██╗██║  ╚██╗ ██╔╝╚══██╔══╝██║██╔════╝██╔════╝
 *    ███████║██╔██╗ ██║███████║██║   ╚████╔╝    ██║   ██║██║     ███████╗
 *    ██╔══██║██║╚██╗██║██╔══██║██║    ╚██╔╝     ██║   ██║██║     ╚════██║
 *    ██║  ██║██║ ╚████║██║  ██║███████╗██║      ██║   ██║╚██████╗███████║
 *    ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝      ╚═╝   ╚═╝ ╚═════╝╚══════╝
 *                                                                        
 */

 Hyperyun.Analytics = {
  _session_id: null,
  _events: [],
  _unsentEvents: []
 }

 Hyperyun.Analytics.track = function(event, data) {
    Hyperyun.Analytics._events.push({name: event, data: data});
    if(Hyperyun.Hyperstore &&  Hyperyun.Hyperstore.hyperyunTracking && Hyperyun.Analytics._session_id) {
        Hyperyun.Hyperstore.hyperyunTracking.update({_id: Hyperyun.Analytics._session_id}, {"$push":{events:{name: event, data: data}}});
    } else {
        Hyperyun.Analytics._unsentEvents.push({name: event, data: data});
    } 
 }

/***
 *    ██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ███████╗████████╗ ██████╗ ██████╗ ███████╗
 *    ██║  ██║╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██╔════╝╚══██╔══╝██╔═══██╗██╔══██╗██╔════╝
 *    ███████║ ╚████╔╝ ██████╔╝█████╗  ██████╔╝███████╗   ██║   ██║   ██║██████╔╝█████╗  
 *    ██╔══██║  ╚██╔╝  ██╔═══╝ ██╔══╝  ██╔══██╗╚════██║   ██║   ██║   ██║██╔══██╗██╔══╝  
 *    ██║  ██║   ██║   ██║     ███████╗██║  ██║███████║   ██║   ╚██████╔╝██║  ██║███████╗
 *    ╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚══════╝╚═╝  ╚═╝╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝
 *                                                                                       
 */
Hyperyun.Hyperstore = function(server, options,callback){
  //Stuff to do if 'new Hyperyun.Hyperstore' is called
  if(Hyperyun.Hyperstore)
  {
    if(!options)options={};
    if(_.isString(server))
    {
      var sobj = hyperstore_utils.breakServerURLIntoObject(server);
      var targetColl = sobj.collection;
      var appName = sobj.application;
      options.fullserverurl = sobj.toString();
      options.server = options.server?options.server:sobj.host;
    }
    else
    {
      var targetColl = options.collection;
      var appName = options.appName;
    }
    //Let initialize use default init target
    var result = Hyperyun.Hyperstore.initialize(appName,[targetColl],options,undefined,targetColl)
    setTimeout(function(){if(callback) callback(Hyperyun.Hyperstore.wireID);},5)//TODO: This a way to call the callback after the return for back-compatibility :-\
    return result;
  }
}

Hyperyun.Hyperstore.initialize = function(appName, collectionList, options, initTarget, collectionToReturn){
  if(!appName) console.error("appName undefined...");
  var kHost = Hyperyun.COMPANY_DOMAIN;
  var firstApplicationBeingInitialized = false;
  if(!collectionList)collectionList = [];

  //First initialization occuring -> we'll have to make Hyperstore.[coll] aliases
  if(!Hyperyun.Hyperstore.apps){
    firstApplicationBeingInitialized = true;
    Hyperyun.Hyperstore.apps = {};
  }
  //Usefully default target to unibody object
  if(!initTarget) initTarget = Hyperyun.Hyperstore.apps[appName] = Hyperyun.Hyperstore.apps[appName]?Hyperyun.Hyperstore.apps[appName]:{};

  //Hyperyun.Logger Collection push
  if(!_.contains(collectionList,"hyperyunLogs")) collectionList.push('hyperyunLogs');
  //Hyperyun.Analytics Collection push
  if(!_.contains(collectionList,"hyperyunTracking")) collectionList.push('hyperyunTracking');
  //Hyperyun users push, for getUser
  if(!_.contains(collectionList,"users")) collectionList.push('users');
  //Similarly, keep pulse of hyperyunAdmins so appowners/admins can login
  if(!_.contains(collectionList,"hyperyunAdmins")) collectionList.push('hyperyunAdmins');

  collectionList = _.compact(_.unique(collectionList));
  //Prepare options
  if(!options)options={};
  options.server = options.server?options.server:kHost;
  var serverAddress = options.fullserverurl?options.fullserverurl:appName +"."+ options.server;//appName+(options && options.server?"."+options.server:"."+kHost);
  console.log("Server Address initializing with ",serverAddress,"on",appName);

  //Do Initializing
  if(!initTarget._hyperstore)
    initTarget._hyperstore = new Hyperyun._Hyperstore(serverAddress,options);
  initTarget._hyperstore.application = initTarget;
  //Filter out existing initialized things
  collectionList = _.filter(collectionList, function(coll){
    return !_.find(initTarget.collections, function(v){
      return v.collName == coll && //Same collection name... only let initialize if it points at a different server
      v.server == serverAddress
    })
  })
  console.log("Initializing (",appName,"): ",collectionList);
  initTarget.collections = _.compact(_.union(initTarget.collections, _.map(collectionList, function(v){return {collName:v, server: serverAddress}})))
  
  _.each(_.compact(collectionList), function(coll){
    var switchboard = new Hyperyun.Hyperstore.SwitchBoard(initTarget, initTarget._hyperstore, coll);
    initTarget[coll] = switchboard
    if(firstApplicationBeingInitialized) //Hyperyun.Hyperstore.[coll] aliases
      Hyperyun.Hyperstore[coll] = initTarget[coll]
    initTarget._hyperstore._unstashFromLocalStorage(coll,_.bind(initTarget._hyperstore._registerCollectionAfterUnstash,initTarget._hyperstore));
  });

  initTarget._hyperstore._checkLogin(function(userinfo){
    console.log("CHECKLOGGINED:",userinfo)
    if(userinfo) initTarget._hyperstore.user = userinfo;
    initTarget._hyperstore.trigger(undefined,'connect')
  });
  //Do Hyperstore[app].alias()
  if(_.size(collectionList)>0)
  {
    function bindToBW(fn){return _.bind(_.partial(fn,collectionList[0]),initTarget._hyperstore)}
    initTarget._debug = initTarget._hyperstore._debug;
    initTarget.on         = bindToBW(initTarget._hyperstore.on);
    initTarget.trigger    = bindToBW(initTarget._hyperstore.trigger);
    initTarget.getUser    = bindToBW(initTarget._hyperstore.getUser);
    initTarget.createUser = bindToBW(initTarget._hyperstore.createUser);
    initTarget.activate   = bindToBW(initTarget._hyperstore.activate);
    initTarget.login      = bindToBW(initTarget._hyperstore.login);
    initTarget.logout     = bindToBW(initTarget._hyperstore.logout);
    initTarget.changePassword = bindToBW(initTarget._hyperstore.changePassword);
    initTarget.forgotPassword = bindToBW(initTarget._hyperstore.forgotPassword);
    initTarget.generateAPIKey = bindToBW(initTarget._hyperstore.generateAPIKey);
    initTarget._getAppOwnerTargets = bindToBW(initTarget._hyperstore._getAppOwnerTargets);
    initTarget._retrieveLoginCredentials = bindToBW(initTarget._hyperstore._retrieveLoginCredentials);
    initTarget.requestApplicationStatistics = bindToBW(initTarget._hyperstore.requestApplicationStatistics);
  }
  if(Object.__defineGetter__)
    initTarget.__defineGetter__("user", function(){
        return initTarget._hyperstore.user;
    });
  else
  {
    if(!initTarget._hyperstore.bruteUserAliasEnabled) initTarget._hyperstore.bruteUserAliasEnabled = [];
    initTarget._hyperstore.bruteUserAliasEnabled.push(initTarget)
  }
  if(firstApplicationBeingInitialized){//mock the above onto Hyperyun.Hyperstore
    function bindToBW(fn){return _.bind(_.partial(fn,collectionList[0]),initTarget._hyperstore)}
    Hyperyun.Hyperstore._debug = initTarget._hyperstore._debug;
    Hyperyun.Hyperstore.on         = bindToBW(initTarget._hyperstore.on);
    Hyperyun.Hyperstore.trigger    = bindToBW(initTarget._hyperstore.trigger);
    Hyperyun.Hyperstore.getUser    = bindToBW(initTarget._hyperstore.getUser);
    Hyperyun.Hyperstore.createUser = bindToBW(initTarget._hyperstore.createUser);
    Hyperyun.Hyperstore.activate   = bindToBW(initTarget._hyperstore.activate);
    Hyperyun.Hyperstore.login      = bindToBW(initTarget._hyperstore.login);
    Hyperyun.Hyperstore.logout     = bindToBW(initTarget._hyperstore.logout);
    Hyperyun.Hyperstore.changePassword = bindToBW(initTarget._hyperstore.changePassword);
    Hyperyun.Hyperstore.forgotPassword = bindToBW(initTarget._hyperstore.forgotPassword);
    Hyperyun.Hyperstore.generateAPIKey = bindToBW(initTarget._hyperstore.generateAPIKey);
    Hyperyun.Hyperstore.requestApplicationStatistics = bindToBW(initTarget._hyperstore.requestApplicationStatistics);
    Hyperyun.Hyperstore._getAppOwnerTargets = bindToBW(initTarget._hyperstore._getAppOwnerTargets);
    Hyperyun.Hyperstore._retrieveLoginCredentials = bindToBW(initTarget._hyperstore._retrieveLoginCredentials);
    if(Object.__defineGetter__)
      Hyperyun.Hyperstore.__defineGetter__("user", function(){
          return initTarget._hyperstore.user;
      });
    else
    {
      if(!initTarget._hyperstore.bruteUserAliasEnabled) initTarget._hyperstore.bruteUserAliasEnabled = [];
      initTarget._hyperstore.bruteUserAliasEnabled.push(Hyperyun.Hyperstore)
    }
  }
  if(collectionToReturn)
    return initTarget[collectionToReturn]
  return initTarget;
}

//The switchboard object lets us alias 'Hyperstore.foo.op()' into a call on Hyperstore.op('foo') internally
Hyperyun.Hyperstore.SwitchBoard = function(application, hyperstore, collectionTarget){
  var self = this;
  this.collection = collectionTarget;
  this.hyperstore = hyperstore;
  if(Object.__defineGetter__)
    this.__defineGetter__("user", function(){
        return application._hyperstore.user;
    });
  else
  {
    if(!application._hyperstore.bruteUserAliasEnabled) application._hyperstore.bruteUserAliasEnabled = [];
    application._hyperstore.bruteUserAliasEnabled.push(application)
  }
  //Function API wrappers
  //When a user does Hyperstore.foo.find(blah,blah,blah), the middle man function calls Hyperstore.find('foo',blah,blah,blah)
  this.resetReactivity = _.bind(_.partial(this.hyperstore.resetReactivity,this.collection),this.hyperstore);
  this.generateAPIKey = _.bind(_.partial(this.hyperstore.generateAPIKey,this.collection),this.hyperstore);
  this.requestApplicationStatistics = _.bind(_.partial(this.hyperstore.requestApplicationStatistics,this.collection),this.hyperstore);
  this.findOne = _.bind(_.partial(this.hyperstore.findOne,this.collection),this.hyperstore);
  this.find = _.bind(_.partial(this.hyperstore.find,this.collection),this.hyperstore);
  this.insert = _.bind(_.partial(this.hyperstore.insert,this.collection),this.hyperstore);
  this.update = _.bind(_.partial(this.hyperstore.update,this.collection),this.hyperstore);
  this.remove = _.bind(_.partial(this.hyperstore.remove,this.collection),this.hyperstore);
  this.subscribe = _.bind(_.partial(this.hyperstore.subscribe,this.collection),this.hyperstore);
  this.emit = _.bind(_.partial(this.hyperstore.emit,this.collection),this.hyperstore);
  this.on = _.bind(_.partial(this.hyperstore.on,this.collection),this.hyperstore);
  this.trigger = _.bind(_.partial(this.hyperstore.trigger,this.collection),this.hyperstore);
  this.createUser = _.bind(_.partial(this.hyperstore.createUser,this.collection),this.hyperstore);
  this.getUser =  _.bind(_.partial(this.hyperstore.getUser, this.collection),this.hyperstore);
  this.sendAnalyticsEvent = _.bind(_.partial(this.hyperstore.sendAnalyticsEvent,this.collection),this.hyperstore);
  this.pingLogin = _.bind(_.partial(this.hyperstore.pingLogin,this.collection),this.hyperstore);
  this.login = _.bind(_.partial(this.hyperstore.login,this.collection),this.hyperstore);
  this.logout = _.bind(_.partial(this.hyperstore.logout,this.collection),this.hyperstore);
  this.changePassword = _.bind(_.partial(this.hyperstore.changePassword,this.collection),this.hyperstore);
  this.forgotPassword = _.bind(_.partial(this.hyperstore.forgotPassword,this.collection),this.hyperstore);
  this.activate = _.bind(_.partial(this.hyperstore.activate,this.collection),this.hyperstore);
  this.removeFile = _.bind(_.partial(this.hyperstore.removeFile,this.collection),this.hyperstore);
  this.upload = _.bind(_.partial(this.hyperstore.upload,this.collection),this.hyperstore);
  this.cancelUpload = _.bind(_.partial(this.hyperstore.cancelUpload,this.collection),this.hyperstore);
  this.forceFind = _.bind(_.partial(this.hyperstore.forceFind,this.collection),this.hyperstore);
  this.closeFind = _.bind(_.partial(this.hyperstore.closeFind,this.collection),this.hyperstore);
  this.ping = _.bind(_.partial(this.hyperstore._debug.ping,this.collection),this.hyperstore);
  this._getAppOwnerTargets = _.bind(_.partial(this.hyperstore._getAppOwnerTargets,this.collection),this.hyperstore);
  this._retrieveLoginCredentials = _.bind(_.partial(this.hyperstore._retrieveLoginCredentials,this.collection),this.hyperstore);
  this._chmod = _.bind(_.partial(this.hyperstore._chmod,this.collection),this.hyperstore);
  this._applyChmod = _.bind(_.partial(this.hyperstore._applyChmod,this.collection),this.hyperstore);
  this.subscribe = _.bind(_.partial(this.hyperstore.subscribe, this.collection), this.hyperstore);
  this.emit = _.bind(_.partial(this.hyperstore.emit, this.collection), this.hyperstore);
}

Hyperyun._Hyperstore = function(server, options, callback) {
  var that = this;
  if(typeof options == 'function')
  {
    callback = options;
    options = {};
  }
  if(options && (options.silent || !options.debug))
    toggleLogExclusionSet = 'totalSilence'
  if (_.isString('server')) {
    var sobj = hyperstore_utils.breakServerURLIntoObject(server);
    options.appName = sobj.application;
    options.protocol = sobj.protocol;
    options.server = sobj.protocol + "://" + sobj.host + ":" + sobj.port;
    options.serverURI = sobj.toString();
    options.host = sobj.host;
    options.collection = sobj.collection;
    options.port = sobj.port;
    if(!options) var options = new Object();
  } else {
    options = server;
  }
  this.collectionFindLists = {};
  this.collectionUserCallbacks = {};
  this.buckets = {};
  this.options = options;
  this.wireID = hyperstore_utils.generateUID();
  this.appName = options.appName;
  this.server = options.server;
  this.healthCheckInterval = options.healthCheckInterval;
  this.loginApp = options.loginApp?options.loginApp:options.appName;
  this.domain = options.domain;
  this.socket = io(options.server, {query:"appName="+this.appName, 'sync disconnect on unload': true});
  this.socketID = this.wireID;
  this.currentUploads = new Object();
  this.isConnected = false;
  this.LocalCollections = {};
  this.user = null;
  this.manuallyMaintainUserAlias(null)
  this.oauthmethods = ['google','sina','weibo','facebook','github','twitter']
  this._debug = {
    ping : function(collection, callback){
      that.socket.emit('ping',{collection: collection,
                                appName: that.appName,
                                version: that.version,
                                socketid: that.socketID, eventOrigination: new Date()},callback);
    }
  }
  this.loginToken = null;
  if(typeof window != 'undefined') {
    this.cookieName = this.loginApp + "-HyperyunToken";
    this.cookieMethodName = this.loginApp+"-HyperyunMethod";
    this.cookie = cookie;
    this.cookie.defaults.expires = 30;
    this.cookie.defaults.domain = this.options.domain || Hyperyun.COMPANY_DOMAIN;
    this.loginToken = this._retrieveValueFromLocalStorage(this.cookieName)? this._retrieveValueFromLocalStorage(this.cookieName).token : this.cookie.get(this.cookieName);
  }
  if(!this.collectionEvents) this.collectionEvents = {};
  if(callback) callback();
}

Hyperyun._Hyperstore.prototype._registerCollectionAfterUnstash = function(op){
  var self = this;
  var collection = op.res;//unstash returns collection name upon success;
  if(op.err)
  {
    self.LocalCollections[collection] = new LocalCollection();
    self.collectionFindLists = self.collectionFindLists?self.collectionFindLists:{};
    self.collectionFindLists[collection]={};
    self.collectionUserCallbacks = self.collectionUserCallbacks?self.collectionUserCallbacks:{};
    self.collectionUserCallbacks[collection]=new Array();
    self.buckets = self.buckets?self.buckets:{};
    self.buckets[collection] = {};
  }
  self.LocalCollections[collection]._useOID = true;
  self.collectionUserCallbacks[collection]=new Array();
  self.queryList = new Array();
  self.queue = new Array();
  self.version = null;

  self.reconnectTables = {};
  self.disconnectStrategy = {};
  self.defaultDisconnectStrategy = 1;

  if(self.options.debug) self.debug=self.options.debug;
  else self.debug=false;


  self.events = {
    'connect': function() {
      togglelog("Hyperyun: Connected!");
      self._execQueue();
    },
    'reconnect': function(queue){
      if(self.debug)
      {
        togglelog("Hyperyun: Reconnected");
        _.each(queue, function(element){togglelog(element)})
      }
    },
    'remoteLogout':function(){

    },
    'update': function() {
      togglelog("Hyperyun: Updated!");
      self._execQueue();
    },

    'oauthLogin': function() {

    },
  };

  if(!self.collectionEvents[collection])self.collectionEvents[collection] = {};

  self.collectionEvents[collection].onE = {
    'connect': function() {},
    'disconnect': function(){},
    'update': function(){},
    'insert': function(){},
    'remove': function(){},
    'ready': function(){},
    'remoteLogout': function(){},
    'reconnect': function(){}
  };

 function prepareSocketEvents(userinfo){
    var collectionName = "/"+self.appName+"|"+collection;
    self.buckets[collectionName] = io(self.server+collectionName);
    self.models = new Array();
    self.buckets[collectionName].on('getChown',function(data){
      self._applyChown(collection, data.sel, data.opt)
      if(false)//TODO: only checkViews if admin
      {
        self._checkViews(collection, 'chown', data);
      }
    })
    self.buckets[collectionName].on('getChmod',function(data){
      self._applyChmod(collection, data.sel, data.opt);
      if(false)//TODO: only checkViews if admin
      {
        self._checkViews(collection, 'chmod', data);
      }
    })
    self.buckets[collectionName].on('getInsert', function(data){
      togglelog("getInsert",'event');
      togglelog(data,'event');
      if(data.socketid!=self.socketID) {
        try{
          if(self.LocalCollections[collection]) self.LocalCollections[collection].insert(data.sel);
          self._checkViews(collection,'insert',data);
          self.version = data.version;
          self.events.update();
          self.trigger(collection,'insert',data.sel);
        } catch(e){
          console.error("error on getInsert",e,data.sel,data.socketid,self.socketID)
        }
      }
    });

    self.buckets[collectionName].on('getRemove', function(data){
      togglelog("getRemove",'event',data);
      togglelog(data,'event');
      if(data.socketid!=self.socketID) {
        try{
          options = data.opt?data.opt:{};
          options.limit = options.multi && !options.single?undefined:1
          if(self.LocalCollections[collection])
          {
            var copy = self.LocalCollections[collection].find(data.sel,options).fetch();
            var size = copy.length;
            _.each(copy,function(doc){
              self.LocalCollections[collection].remove({_id:doc._id});
              size--;
              if(size <=0)
              {
                self._checkViews(collection,'remove',data);
              }
            })
          }
          else
          {
            self._checkViews(collection, 'remove', data);
          }
          self.version = data.version;
          self.events.update();
          self.trigger(collection,'remove',data.sel);
        }catch(e){
          console.error("error on getRemove:",e)
        }
      }
    });

    self.buckets[collectionName].on('getUpdate', function(data){
      togglelog("getUpdate",data);
      togglelog(data,'show');
      if(data.socketid != self.socketID) {
        try{
          if(self.LocalCollections[collection]) self.LocalCollections[collection].update(data.sel, data.mod, data.opt);
          self._checkViews(collection, 'update',data);
          self.version = data.version;
          self.events.update();
          self.trigger(collection,'update',{selector:data.sel, modifier:data.mod, options:data.opt});
        } catch(e){
          console.error("error on getUpdate:", e)
        }
      }
    });
    self.socket.on('remoteLogout', function(){
        self.trigger(collection,'remoteLogout');
        self._onRemoteLogout(collection);
    })
    self.socket.on('disconnect', function(){
        self.trigger(collection, 'disconnect');
        togglewarn("Hyperyun: Disconnected");
    });
    self.socket.on('reconnect', function() {
        //self.trigger('connect');
        self._forceReconnectSideEffects(collection);
        self._checkViews(collection, "forceInterrogation");
        console.log("Hyperyun: Reconnected.");
    });

    self.isConnected = true;
    // Hyperyun.Logger run
    if(collection == "hyperyunLogs" && (typeof disableHyperyunLogger == "undefined" || !disableHyperyunLogger)) {
      // Initiate a new document for Hyperyun.Logger
      self.insert(collection, {clientInfo: Hyperyun._clientInfo, logs: Hyperyun.Logger._unsentLogs}, {}, function(docs, err) {
        if(!err && docs[0]) { 
          Hyperyun.Logger._session_id = docs[0]._id;
          // Empty array (10x faster than a.length=0)
          while(Hyperyun.Logger._unsentLogs.length > 0) {
            Hyperyun.Logger._unsentLogs.pop();
          }
        }
      });
    } else if(collection == "hyperyunTracking" && (typeof disableHyperyunTracker == "undefined" || !disableHyperyunTracker)) {
      // Initiate a new document for Hyperyun.Logger
      self.insert(collection, {clientInfo: Hyperyun._clientInfo, events: Hyperyun.Analytics._unsentEvents}, {}, function(docs, err) {
        if(!err && docs[0]) 
        Hyperyun.Analytics._session_id = docs[0]._id;
        // Empty array (10x faster than a.length=0)
        while(Hyperyun.Analytics._unsentEvents.length > 0) {
          Hyperyun.Analytics._unsentEvents.pop();
        }
      });
    }
    // End of Hyperyun.Logger Code
    self.events.connect();
    self.trigger(collection,'connect');
    self.trigger(collection,'ready');
    self._execGetUserCallbacks(collection,self.user,5);
  }
  prepareSocketEvents(self.user);
}
//   █████╗ ██████╗ ██╗
//  ██╔══██╗██╔══██╗██║
//  ███████║██████╔╝██║
//  ██╔══██║██╔═══╝ ██║
//  ██║  ██║██║     ██║
//  ╚═╝  ╚═╝╚═╝     ╚═╝
// Public API calls
Hyperyun._Hyperstore.prototype.resetReactivity = function(collection, callback){
  var self = this;
  if(self.findList)
  {
    var keys = _.keys(self.findList);
    for(var i = 0; i < _.size(keys); i++)
      delete self.findList[keys[i]].query.callback;
    if(callback) try{callback(true,false,new Date());}catch(e){console.error("Error in user's resetReactivity callback:",e);throw e;};
  }
  else if(callback) try{callback(false, 'Hyperyun error: reactive find list does not exist. No callbacks removed', new Date())}catch(e){console.error("Error in user's insert callback:",e);throw e;};;
}
Hyperyun._Hyperstore.prototype.generateAPIKey = function(collection, appName, callback){
  var that = this;
  var options = {
    appName: appName,
    loginApp: that._getLoginApp(),
    loginToken: that.loginToken, eventOrigination: new Date()};
  that.socket.emit('generateAPIKey',options, function(res){
    if(callback) try{callback(res.res, res.err, res.info)}catch(e){console.error("Error in user's generateAPIKey callback:",e);throw e;};;
  })
}
Hyperyun._Hyperstore.prototype.requestApplicationStatistics = function(collection, appName, callback){
  var that = this;
  var options = {
    appName: appName,
    loginApp: that._getLoginApp(),
    loginToken: that.loginToken, eventOrigination: new Date()};
  that.socket.emit('requestApplicationStatistics', options, function(res){
    if(callback) try{callback(res.res, res.err, res.info)}catch(e){console.error("Error in user's requestApplicationStatistics callback:",e);throw e;};
  })
}

Hyperyun._Hyperstore.prototype.findOne = function(collection, selector, options, callback) {
  if(typeof arguments[1] == 'function')
  {
    callback = arguments[1];
    options = null;
    selector = null;
  }
  if(typeof arguments[2] == 'function')
  {
    selector = selector;
    callback = arguments[2];
    options = null;
  }
  if(!options) options = {reactive:true};
  options.limit = 1;
  options.nakedFirst = true;
  return this._find(collection, selector, options, callback);
}
Hyperyun._Hyperstore.prototype.find = function(collection, selector, options, callback)
{
  return this._find(collection, selector, options, callback);
}
Hyperyun._Hyperstore.prototype._remoteFind = function(collection, selector, options, callback){
  var self = this;
  var toEmit = { 
    sel:selector, opt:options, collection: collection, appName: self.appName, eventOrigination : new Date(),
    version: self.version, socketid: self.socketID, loginApp: self._getLoginApp(), loginToken: options && options.loginToken?options.loginToken:self.loginToken
  }
  //console.info("emitting remote find",toEmit,callback);
  self.socket.emit('find', toEmit, callback);  
}
Hyperyun._Hyperstore.prototype._syncLocalFind = function(collection, selector, options, callback)
{
  var self = this;
  function onFindCallback(res)
  {
    //console.info("on the remote find return, res:",res)
    if(res.err){
      callback(undefined,res.err,res.info)
      return;
    }
    for (var i = 0; res.array && i < res.array.length; i++) {
      var mod = res.array[i];
      self.LocalCollections[collection].remove({_id: mod._id});
      self.LocalCollections[collection].insert(mod);
    }
    if(callback)callback(res.array, res.err, res.info)
  }
  self._remoteFind(collection,selector,options,onFindCallback);
}
Hyperyun._Hyperstore.prototype._localFind = function(collection, selector, options, callback, reactiveAction){
    var self = this
    var array = self.LocalCollections[collection].find(selector,options).fetch();
    
    if(reactiveAction && options.reactive) reactiveAction(array)
    if(options)//Post-processing
    {
      if(options.projection && !_.any(options.projection,function(val){return val==0}))
      {
        options.projection._id=1;
        array = _.map(array,function(val){return _.pick(val,_.keys(options.projection))})
      }
      if(options.showBWDocs){
        array = _.map(array,censorBW_Doc);
      }
    }
    //Handle findOne api promise differences
    if(options.nakedFirst)
      array = (array && array.length > 0)?array[0]:undefined;
    if(callback) try{callback(array,false,{version: new Date()})}catch(e){console.error("Error in user's find callback:",e);throw e;}
}
Hyperyun._Hyperstore.prototype._find = function(collection, selector, options, callback, flags){
  //SANITIZE INPUT
  var that=this;
  flags = flags?flags:{};
  var findList = that.collectionFindLists[collection]?that.collectionFindLists[collection]:{};
  if(typeof arguments[1] == 'function')
  {
    callback = arguments[1];
    options = null;
    selector = null;
  }
  else if(typeof arguments[2] == 'function')
  {
    callback = arguments[2];
    options = null;
  }
  if(!selector) selector={};
  if(!options) options={};
  if(options.reactive !== false) options.reactive = true;
  if(options.projection){
    options.fields = options.projection;
    if(_.size(_.uniq(_.values(options.projection))) > 1)
    {
      if(callback) try{callback([],"Hyperyun: Error: Differentiated projection disallowed in Mongo.", {version:new Date()})}catch(e){console.error("Error in user's find callback:",e);throw e;};
      return false;
    }
  }  
  //DETERMINE IF LOCAL FIND SUFFICIENT - IS THIS FIND A MEMBER OR A SUBSET OF THE CURRENT FINDLIST QUERIES?
  var q = {collection: collection, selector: selector, options: options, single:options.nakedFirst};
  var hit = _.find(findList,function(view){return _.isEqual(view.query.selector,q.selector) && _.isEqual(view.query.options, q.options)});
  var cover = hit?hit:that._queryIsStrictSubsetOfFindListQuery(collection, q);
  var uid = hit && options.reactive ? hit.uid : hyperstore_utils.generateUID();

  if(options.reactive && !flags.doNotPushCallback)
      that._registerReactiveView(collection, uid, hit?hit:q, callback)

  function rehash(target, array){
    //console.warn("rehashing",target,array)
    if(target)
      target = _.extend(target, {
          prevCacheHash: target.cacheHash,
          cacheHash: murmur(JSON.stringify(array),0)})
  }
  //Perform local find on minimongo
  if(flags.forceLocal || (((hit && hit.hasRun) || (cover && cover.hasRun) || flags.checkview) && !flags.forceRemote))
  {
    //console.info("doing local find")
    that._localFind(collection, selector, options, callback, function(lArray){
      //Update findList entry (hashed)
      if(!flags.dontRehash) rehash(findList[uid], lArray)
    })
  }
  //
  else if(flags.noMinimongo)
  {
    //console.info("doing remote find")
    that._remoteFind(collection, selector, options, function(res){
      var array = res.array;
      var err = res.err
      if(err){ callback(array, err, res.info); return; }

      if(!flags.dontRehash) rehash(findList[uid], array);
      if(findList[uid])
        findList[uid] = _.extend(findList[uid], {
          hasRun : true,
          cache : hyperstore_utils.deepKeys(rArray,true)})
      if(callback)
          try{
            callback((findList[uid].cache != findList[uid].prevCacheHash ? array : false), err, res.info)
          }catch(e){console.error("Error in user find callback",e)}
    });
  }
  //Sync with remote, then perform local find on minimongo
  else
  {
    that._syncLocalFind(collection, selector, options, function(rArray, err, info){
      that._localFind(collection, selector, options, callback, function(lArray){
        //Update findList entry (hashed & synced)
        if(!flags.dontRehash) rehash(findList[uid], lArray);
        if(findList[uid])
          findList[uid] = _.extend(findList[uid], {
            hasRun : true,
            cache : hyperstore_utils.deepKeys(rArray,true)})
          })
      })
  }
  return options.reactive?new Hyperyun._Hyperstore.FindInstance(collection, that, uid):false
}

Hyperyun._Hyperstore.prototype._registerReactiveView = function(collection, uid,view,callback){
  /*
    view contains everything a find needs to be reactive. It should have the following form:
      {
        collection: collection to run query on
        selector: selector for query
        options: options for query
        single: whether find should just return first result 
        callback: array of callbacks to trigger when this find updates, if view already exists in findlist
      }
   */
  var that=this;
  var findList = that.collectionFindLists[collection]?that.collectionFindLists[collection]:{};
  if(!findList[uid])
    findList[uid] = {uid: uid, query: view}
  if(!findList[uid].query){
    console.error("View ",uid,"malformed: no query to add callback to.(",view,")"); 
    return
  }
  if(!_.isArray(findList[uid].query.callback))
  {
    findList[uid].query.callback = [findList[uid].query.callback];
  }
  if(_.isArray(callback))
  {
    _.forEach(callback,function(fn){
      findList[uid].query.callback.push(fn);
    })
  }
  else if(_.isFunction(callback))
  {
    findList[uid].query.callback.push(callback);
  }
}

Hyperyun._Hyperstore.prototype._checkViews = function(collection, method, data){
  var that = this;
  var findList = that.collectionFindLists[collection]?that.collectionFindLists[collection]:{};
  //STEP 1 : DETERMINE WHICH FIND LISTS ARE AFFECTED
  var viewModificationStatus = new Array();
  if(method == 'insert')
  {
    //See if change changes the size of any of our queries
    var selector = data.sel;
    viewModificationStatus = _.map(findList, function(view){
      togglelog("Insert view.selector: " + JSON.stringify(view.query.selector));
      if(!_.isEqual(view.query.selector,{}) && //If the view is asking for everything, assume query affects this view
         _.size(_.intersection(that._getAllSubKeys(selector), that._getAllSubKeys(view.query.selector)))==0) //See if selector keys coincide at all
      {
        togglewarn("ignoring insert event: doesn't affect me");
        return {r:false, id: view.uid};
      }
      //Be conservative: assume query altered if above not met
      return {r: true, id: view.uid};
    });
  }
  else if(method == 'remove')
  {
    togglelog('check onRemove');
     //See if change changes the size of any of our queries
    var selector = data.sel;
    viewModificationStatus = _.map(findList, function(view){
      if(!_.isEqual(view.query.selector,{}) && !_.isEqual(selector,{}) && //If the view is asking for everything, assume query affects this view
         _.size(_.intersection(that._getAllSubKeys(selector), that._getAllSubKeys(view.query.selector)))==0 && //See if selectors have in-common keys
         _.size(_.intersection(that._getAllSubKeys(selector), view.cache))==0)
      {
        togglewarn("ignoring remove event: doesn't affect me:",that._getAllSubKeys(selector));
        return {r:false, id: view.uid};
      }
      //Be conservative: assume query altered if above not met
      return {r:true, id:view.uid};
    });
  }
  else if(method == 'update')
  {
    var selector = data.sel;
    var modifier = data.mod;
    var options = data.options;
    togglelog('check onUpdate',selector,modifier,options);
    //See if change modifies any fields we are watching
    viewModificationStatus = _.map(findList, function(view, key){
      if(!_.isEqual(view.query.selector,{}) &&
         _.size(_.intersection(that._getAllSubKeys(modifier), that._getAllSubKeys(view.query.selector)))==0 &&
         _.size(_.intersection(that._getAllSubKeys(selector), view.cache))==0)
      {
        togglewarn("ignoring update event: doesn't affect me",view.uid);
        return {r:false, id: view.uid}
      }
      //findOne by _id case (update selectos on _id, findOne selects on _id)
      if(
          selector._id !== undefined && _.isString(selector._id) && //update selects on _id
          view.query.selector._id !== undefined && _.isString(view.query.selector._id) && //query selects on _id
          selector._id != view.query.selector._id //they select on different _id's
        )
      {
        togglewarn("ignoring update event: different _id in _id-centric case",view.uid);
        return {r:false, id: view.uid}
      }
      //Be conservative: assume query altered if above not met
      return {r:true, id:view.uid};
    });
  }
  else if(method == 'forceInterrogation')
  {
    viewModificationStatus = _.map(findList, function(view, key){
      return {r:true, id:view.uid};
    })
  }
  //STEP 2 : FOR EACH AFFECTED FIND, DO A NON-REACTIVE FIND TO GET NEW RESULTS, THEN RUN THE FINDS' CALLBACKS
  _.forEach(viewModificationStatus, function(element, index){
    if(element.r)
    {
      var view = findList[element.id];
      var checkOpts = _.defaults({reactive:true},view.query.options);
      var startTime = new Date();
      var cacheHashAtCheck = view.cacheHash;
      function checkCallback(res,err,info){
        function rerunCallbacks(){
          //console.log("@,P,C:",cacheHashAtCheck,view.prevCacheHash,view.cacheHash);
          if(view.cacheHashAtCheck != view.cacheHash){
            if(checkOpts.reportHashing)console.warn("Source and Target md5s differed");
            var debug = {
              timing : data && data.timing?data.timing:undefined,
              triggerPropagated : startTime,
              effectsFound : new Date(),
              fromCheckView : true,
              respondingTo : method
            }
            info = _.extend(info,{debug:debug, event:{type:method, details:data}});

            //Do callbacks
            _.forEach(view.query.callback, function(cb){
              if(!_.isFunction(cb))return;
              try{if(cb)cb(res,err,info)}catch(e){console.error("Error in user's callback upon reconnection:",e)}
            })
            //Trigger events
            if(view.events && view.events[method])
              _.forEach(view.events[method], function(cb){
                try{if(cb)cb(res,err,info)}catch(e){console.error("Error in user's callback upon ",method,":",e)}
              })
            if(view.events && data && data.methodAlias && view.events[data.methodAlias])
              _.forEach(view.events[data.methodAlias], function(cb){
                try{if(cb)cb(res,err,info)}catch(e){console.error("Error in user's callback upon ",data.methodAlias,":",e)}
              })
          }
          else if(checkOpts.reportHashing)console.warn("Source and Target md5s match, skipping callbacks",view.prevCacheHash,view.cacheHash);
        }
        if(view.query.callback){
          if(method == 'forceInterrogation')//we need to get a md5 comparison
          {
            that._find(collection, view.query.selector, checkOpts, function(){
              rerunCallbacks()
            },{doNotPushCallback:true, checkview:true, forceRemote:false, forceLocal: true, dontRehash: true})
          }
          else rerunCallbacks()
        }
      }
      if(method == 'forceInterrogation')
        that._find(collection, view.query.selector, checkOpts, checkCallback, {doNotPushCallback:true, checkview:true, forceRemote:true, forceLocal:false});
      else //we are responding to an event: we just want to check our local state so we can trigger callbacks
        that._find(collection, view.query.selector, checkOpts, checkCallback, {doNotPushCallback:true, checkview:true, forceRemote:false, forceLocal:true});
    }
  });
}

Hyperyun._Hyperstore.prototype.insert = function (collection, insert, options, callback) {
  if(arguments.length == 3)
  {
    if(typeof arguments[2] == 'function')
    {
      callback = arguments[2];
      options = null;
    }
  }
  var that=this;
  if(options && !options.delayUntilConfirmed)
  {
    var id = that.LocalCollections[collection].insert(insert);
    insert._id = id.toString(); //Is now a 'proper' ObjectID
  }
  //documentize objects
  insert = that._recursiveWrapQuery(insert);
  //Emit to everyone else
  that.socket.emit('insert', {collection: collection, appName: that.appName, version: that.version, sel: insert, options:options, socketid: that.socketID, loginApp: that._getLoginApp(), loginToken: options && options.loginToken?options.loginToken:that.loginToken, eventOrigination: new Date()}, function(res) {
    if(res.err && (!res.err.search || res.err.search("duplicate key error") < 0)) {
      that.LocalCollections[collection].remove({_id: id});
      that.queue.push(function (cb) {
        that.insert(collection, insert, callback);
        cb(true);
      });
      if(callback) try{callback(res.res, res.err, res.info)}catch(e){console.error("Error in user's insert callback:",e);throw e;};
    } else {
      that.version=res.info.version;
      if(options && !options.delayUntilConfirmed)
        that.LocalCollections[collection].remove({_id: id});
      // Works only for single doc
      res.res = _.isArray(res.res)?res.res[0]:res.res
      that.LocalCollections[collection].insert(res.res);
      that._checkViews(collection, "insert", {sel: insert, options: options});
      if(callback) try{callback(res.res, res.err, res.info)}catch(e){console.error("Error in user's insert callback:",e);throw e;};
    }
    that._renderAll(collection);
  });
}
Hyperyun._Hyperstore.prototype.update = function (collection, selector, mod, options, callback) {
  var that=this;
  //console.info("PERFORMING UPDATE (",selector,mod,")")
  if(arguments.length == 4)
  {
    if(typeof arguments[3] == 'function')
    {
      callback = arguments[3]
      options = null;
    }
  }
  if(!selector) selector={};
  if(!mod) mod={};
  if(!options) options={};
  delete selector[""];
  delete mod[""];
  var copy = that.LocalCollections[collection].find(selector).fetch();

  //Documentize selector if upsert in-play: selectors add information in this case, so we have to ensure documentization
  //TODO: perhaps handle this differently: it would be nice to keep selectors exactly as specified to stop side-effects/complications
  if(options.upsert)
  {
    var topleveldoc = that.hyperDoc({});
    if(mod.$setOnInsert)
      mod.$setOnInsert.bw_doc = topleveldoc;
    else
      mod.$setOnInsert = {bw_doc: topleveldoc};
  }
  //Documentize modifier

  if(!options.delayUntilConfirmed)
    that.LocalCollections[collection].update(selector, mod, options);
  if(options.multi && !_.any(_.keys(mod), function(key){return key.charAt(0)=='$'}))
  {
    togglewarn("Warning: an update with 'multi = true' cannot affect documents if the modifier is comprised solely of key:value pairs. Use $set and similar keywords.");
  }
  that.socket.emit('update', {collection: collection, appName: that.appName, version: that.version, sel: selector, mod: mod, opt: options, socketid: that.socketID, loginApp: that._getLoginApp(), loginToken: options && options.loginToken?options.loginToken:that.loginToken, eventOrigination: new Date()}, function(res) {
    if(res.err) {
      togglewarn("Error occurred in update: " + res.err);
      if(!options.delayUntilConfirmed)
      {
        that.LocalCollections[collection].remove(selector);
        for (var i = 0; i < _.size(copy); i ++) {
          that.LocalCollections[collection].insert(copy[i]);
        };
      }
      that.queue.push(function (cb) {
        that.update(collection, selector, mod, options, callback);
        cb(true);
      });
      if(callback) try{callback(res.res, res.err, res.info)}catch(e){console.error("Error in user's update callback:",e);throw e;};
    } else {
      if(options.delayUntilConfirmed)
        that.LocalCollections[collection].update(selector, mod, options, function(){});
      that.version=res.info.version;
      that._checkViews(collection, "update", {sel: selector, mod: mod, options: options});
      if(callback) try{callback(res.res, res.err, res.info, res.debug)}catch(e){console.error("Error in user's update callback:",e);throw e;};
    }
  });
}
Hyperyun._Hyperstore.prototype.remove = function(collection, selector, options, callback) {
  if(arguments.length == 3)
  {
    if(typeof arguments[2] == 'function')
    {
      callback = arguments[2];
      options = undefined;
    }
  }
  var that=this;
  if(!selector) {console.error("Remove() requires a selector (even if just {}) to be specified."); return;}//selector={};

  if(options)
  {
    options.single = !options.multi;
    options.multi = !options.single
  }
  else
    options = {single:true, multi:false};
  options.limit = options.multi?undefined:1

  var copy = that.LocalCollections[collection].find(selector,options).fetch();
  if(!options.delayUntilConfirmed)
  {
    _.each(copy,function(doc){
      that.LocalCollections[collection].remove({_id:doc._id});
    })
  }
  that.socket.emit('remove', {collection: collection, appName: that.appName, version: that.version, sel: selector, opt: options, socketid: that.socketID,loginApp: that._getLoginApp(),  loginToken: options && options.loginToken?options.loginToken:that.loginToken, eventOrigination: new Date()}, function(res) {
    if(res.err) {
      if(!options.delayUntilConfirmed)
      {
        for (var key = 0; key < _.size(copy); key++) {
          that.LocalCollections[collection].insert(copy[key]);
        };
      }
      that.queue.push(function (cb) {
        that.remove(collection, selector, options, callback);
        cb(true);
      });
      if(callback) try{callback(res.res, res.err, res.info)}catch(e){console.error("Error in user's remove callback:",e);throw e;};
    } else {
      if(options.delayUntilConfirmed)
      {     
        _.each(copy,function(doc){
          that.LocalCollections[collection].remove({_id:doc._id});
        })
      }
      that.version=res.info.version;
      that._checkViews(collection, "remove", {sel: selector, options:options});
      if(callback) try{callback(res.err, res.info)}catch(e){console.error("Error in user's remove callback:",e);throw e;};
    }
  });
}
Hyperyun._Hyperstore.prototype.on = function (collection, e, fn) {
  var self = this;
  self.collectionEvents[collection].onE[e] = fn;
  if(e == 'ready' && this.isConnected) this.trigger(collection, 'ready',undefined);
}
Hyperyun._Hyperstore.prototype.trigger = function (collection, e,data) {
  var self = this;
  if(collection === undefined)
    _.each(_.keys(self.collectionEvents), function(collection){
      if(self.collectionEvents[collection].onE && self.collectionEvents[collection].onE[e])
        self.collectionEvents[collection].onE[e](data);
      else
        togglewarn("Event not known: "+e);
    })
  else
  {
      if(self.collectionEvents[collection].onE && self.collectionEvents[collection].onE[e])
        self.collectionEvents[collection].onE[e](data);
      else
        togglewarn("Event not known: "+e);
  }
}
Hyperyun._Hyperstore.prototype.createUser = function(collection, info, callback) {
  var that=this;
  that.socket.emit('passwordSignUp', {collection: collection, appName: that.appName, version: that.version, sel: info, socketid: that.socketID, eventOrigination: new Date()}, function(res) {
    if(callback) callback(res.res, res.err, res.info);
  });
}
Hyperyun._Hyperstore.prototype._refreshGetUser = function(collection, user){
  var that = this;
  if(!that.application.users) 
  {
    console.error("GET USER UNSUCCESSFUL: NO USERS TABLE");
    return;//TODO:more robustness needed
  }
  this.closeFind(this.currGetUserFind);
  if(!user && this.currGetUserFind && this.currGetUser != this.user._id)
  {
    this.currGetUser = user;
    that.user = user;
    that._execGetUserCallbacks(collection,that.user,7);
    return;
  }
  var tgtColl = that.user && (that.user.isHyperyunAdmin || that.user.isAppOwner)?'hyperyunAdmins':'users';
  var findID = that._find(tgtColl,{_id: that.user._id},{limit:1},function(res){
    if(!res || res.length < 1){
      res = false;
    }
    else res = res[0];
    if(!_.isEqual(that.user,res))
    {
      that.user = res;
      that.manuallyMaintainUserAlias(that.user)
      that._execGetUserCallbacks(collection,that.user,7);
    }
  },{forceRemote:true,forceLocal:false})
  this.currGetUser = this.user._id;
  this.currGetUserFind = findID;
}
Hyperyun._Hyperstore.prototype.getUser = function(collection, callback) {
  var that = this;
  if(!this.isConnected) {
    togglelog("Hyperyun: Not connected. Adding getUser to queue.");
    this.queue.push(function (cb) {
      this.getUser(collection, callback);
      cb(true);
    });
  } else {
    this._registerGetUserCallback(collection,callback);
    if(this.user && this.user._id != this.currGetUser)
    {
      this._refreshGetUser(collection, user);
    }
    else if(this.user && callback) callback(this.user);
    else if(callback) callback(false);
  }
}
Hyperyun._Hyperstore.prototype.sendAnalyticsEvent = function(collection, eventName, time){
  var that = this;
  that.socket.emit('analyticsEvent',{collection: collection,
                                    appName: that.appName,
                                    version: that.version,
                                    socketid: that.socketID,
                                    time:time,
                                    event:eventName, eventOrigination: new Date()},function(){});
}
Hyperyun._Hyperstore.prototype.pingLogin = function(collection, method, data, callback){
  var that = this;
 that.socket.emit('passwordLogin', {collection: collection, appName: that.appName, version: that.version, login: data, socketid: that.socketID, eventOrigination: new Date()}, function(res) {
  if(res.err) {
    if(callback)callback(res.res, res.err, res.info);
  } else {
    if(callback) callback(res.user, res.err, res.info);
  }
}); 
}
Hyperyun._Hyperstore.prototype.login = function(collection, method, data, callback) {
  var that=this;
  if(method!="password" && !_.contains(Hyperyun._Hyperstore.oauthmethods,method)){
    //Convenience signature
    var withEmail = validator.isEmail(method)
    var constructed_data = {
      username : withEmail?undefined:method,
      email : withEmail?method:undefined,
      password : data
    }
    method = "password";
    data = constructed_data;
  }
  if(method=="password") {
    that.socket.emit('passwordLogin', {collection: collection, appName: that.appName, version: that.version, login: data, socketid: that.socketID, eventOrigination: new Date()}, function(res) {
      if(res.err) {
        //that._refreshGetUser(collection,false);
        if(callback)callback(res.res, res.err, res.info);
      } else {
        that._storePairToLocalStorage(that.cookieName, {token: res.token, expiry: res.exdate});
        that._storePairToLocalStorage(that.cookieMethodName, {method: method, expiry: res.exdate});
        if(that.cookie) that.cookie.set(that.cookieName, res.token, {expires: res.exdate});
        if(that.cookie) that.cookie.set(that.cookieMethodName, method, {expires: res.exdate});
        that.user=res.user;
        that._refreshGetUser(collection,that.user);
        that.manuallyMaintainUserAlias(that.user);
        that.loginToken=res.token;
        that._checkLogin(function(res){
        });
        if(callback) try{callback(res.user, res.err, res.info)}catch(e){console.error("Error in user's login (password) callback:",e);throw e;};
      }
      that._renderAll();
    });
  } else{
    that.socket.emit('getOAuthSettings', {method: method, socket: that.socketID, appName: that.appName, host: that.domain, eventOrigination: new Date()}, function(options, utils) {
      if(options.error) {
        //that._execGetUserCallbacks(collection,false,10);
        that._refreshGetUser(collection,false);
        if(callback)try{callback(res.res, options.error, res.info)}catch(e){console.error("Error in user's login (oauth) callback:",e);throw e;};
        return false;
      }
      var url = utils.url+"?client_id="+utils.client_id;
      if(data.scope && options.scope) delete options.scope;
      for (var key in options) {
        url+="&"+key+"="+options[key];
      };
      for (var key in data) {
        url+="&"+key+"="+data[key];
      };
      if(typeof window != 'undefined') {
        var wnd;
        // create popup
        var wnd_settings = {
          width: Math.floor(window.outerWidth * 0.8),
          height: Math.floor(window.outerHeight * 0.5)
        };
        if (wnd_settings.height < 350)
          wnd_settings.height = 350;
        if (wnd_settings.width < 800)
          wnd_settings.width = 800;
        wnd_settings.left = window.screenX + (window.outerWidth - wnd_settings.width) / 2;
        wnd_settings.top = window.screenY + (window.outerHeight - wnd_settings.height) / 8;
        var wnd_options = "width=" + wnd_settings.width + ",height=" + wnd_settings.height;
        wnd_options += ",toolbar=0,scrollbars=1,status=1,resizable=1,location=1,menuBar=0";
        wnd_options += ",left=" + wnd_settings.left + ",top=" + wnd_settings.top;
        wnd = window.open(url, "Authorization", wnd_options);
        if (wnd) wnd.focus();

        that.socket.on('OAuthLogin', function(data){
          that._storePairToLocalStorage(that.cookieName, {token: data.token, expiry: data.expires});
          that._storePairToLocalStorage(that.cookieMethodName, {method: data.method, expiry: data.expires});
          if(that.cookie) that.cookie.set(that.cookieName, data.token, data.expires);
          if(that.cookie) that.cookie.set(that.cookieMethodName, data.method, data.expires);
          that._checkLogin(function(user){
            //that._execGetUserCallbacks(collection,that.user,11);
            if(callback) try{callback(user)}catch(e){console.error("Error in user's login (oauth) callback:",e);throw e;};
          });
        });
      }
    });
  }
}
Hyperyun._Hyperstore.prototype.logout = function(collection, callback) {
  var that=this;
  var token = null;

  if(that.loginToken && that._retrieveValueFromLocalStorage(that.cookieName))
    {
      token = that.loginToken;
    }
  else if(that.cookie) token = that.cookie.get(that.cookieName);
  that.socket.emit('logout', {appName: that.appName, loginToken: token, eventOrigination: new Date()}, function(res) {
      if(that.cookie) that.cookie.remove(that.cookieName);
      if(that.cookie) that.cookie.remove(that.cookieMethodName);
      that._removeValueFromLocalStorage(that.cookieName);
      that._removeValueFromLocalStorage(that.cookieMethodName);
      that.user=false;
      that.manuallyMaintainUserAlias(that.user);
      that._refreshGetUser(collection,that.user);
      that.loginToken=null;
      if(callback && res) try{callback(res.err, res.info)}catch(e){console.error("Error in user's logout callback:",e);throw e;};
  });
}
Hyperyun._Hyperstore.prototype._onRemoteLogout = function(collection){
  var that = this;
  if(that.cookie) that.cookie.remove(that.cookieName);
  if(that.cookie) that.cookie.remove(that.cookieMethodName);
  that._removeValueFromLocalStorage(that.cookieName);
  that._removeValueFromLocalStorage(that.cookieMethodName);
  that.user=false;
  that.manuallyMaintainUserAlias(that.user);
  that._refreshGetUser(collection,that.user);
  that._renderAll();
}
Hyperyun._Hyperstore.prototype.changePassword = function(collection, oldpassword, newpassword, callback, forgotPassword) {
  var that=this;
  var token = null;
  if(that.cookie) token = that.cookie.get(that.cookieName);
  else token = that.loginToken;
  that.socket.emit('changePassword', {oldpassword: oldpassword, newpassword: newpassword, forgotPassword: forgotPassword, appName: that.appName, loginToken: that.loginToken, eventOrigination: new Date()}, function(res) {
    if(!res.err){
      that.user=res.res;
      that.manuallyMaintainUserAlias(that.user)
      that._refreshGetUser(collection,that.user);
    }
    if(callback)try{callback(res.res?true:false, res.err, res.info)}catch(e){console.error("Error in user's changePassword callback:",e);throw e;};
  });
}
Hyperyun._Hyperstore.prototype.activate = function(collection, code, callback) {
  var that=this;
  that.socket.emit('activate', {code: code, appName: that.appName, eventOrigination: new Date()}, function(res) {
    if(callback) try{callback(res.res, res.err, res.info)}catch(e){console.error("Error in user's activate callback:",e);throw e;};
  });
}
Hyperyun._Hyperstore.prototype.forgotPassword = function(collection, email, callback) {
  var that=this;
    that.socket.emit('forgotPassword', {email: email, appName: that.appName, eventOrigination: new Date()}, function(res) {
      if(!res.err) {
        that.user=res.res;
        that.manuallyMaintainUserAlias(that.user)
        that._refreshGetUser(collection,that.user);
      }
      if(callback)try{callback(res.res, res.err, res.info)}catch(e){console.error("Error in user's forgotPassword callback:",e);throw e;};
    });
}
Hyperyun._Hyperstore.prototype.removeFile = function(collection, fileID, callback){
  var that = this;
  that.socket.emit('removeFile',{
    appName: that.appName,
    socketid: that.socketID,
    loginApp: that._getLoginApp(),
    loginToken: that.loginToken,
    collection : collection,
    file_id : fileID, eventOrigination: new Date()
    }, function(res){
      if(callback) try{callback(res.res, res.err, res.info)}catch(e){console.error("Error in user's removeFile callback:",e);throw e;};
  });
}
Hyperyun._Hyperstore.prototype.cancelUpload = function(collection, identifier, callback){
  var self = this;
  var stream = self.currentUploads[identifier];
  if(stream)
  {
    stream.unpipe();
    stream.emit('disconnect');
    try{callback(true)}catch(e){console.error("Error in user's cancelUpload (true) callback:",e);throw e;};
  }
  try{callback(false)}catch(e){console.error("Error in user's cancelUpload (false) callback:",e);throw e;};
}
Hyperyun._Hyperstore.prototype.upload = function(collection, file, options, callback) {
  var that=this;
  if(typeof options == 'function')
  {
    callback = options;
    options = {};
  }
  if(!options) options = {};
  var folder = options.folder || "/";
  var userData = options.userData || {};
  var filetype = file.name.split('.')[file.name.split('.').length-1];
  // upload a file to the server.
  filestream = ss.createBlobReadStream(file);
  filestream.on('data', function(chunk) {
    if(options.onWrite) options.onWrite(chunk);
  });
  var ident = hyperstore_utils.generateUID();
  that.currentUploads[ident] = filestream;
  var stream = ss.createStream();
  var dataToSend = that._recursiveWrapQuery({
    metadata: {
      name: file.name,
      type: file.type,
      size: file.size,
      folder: folder,
      filetype: filetype,
      userData: userData
    },
    sel:{},
    appName: that.appName,
    socketid: that.socketID,
    loginApp: that._getLoginApp(),
    loginToken: that.loginToken, eventOrigination: new Date()
  },true)
  ss(that.socket).emit('uploadFile', stream, dataToSend, function(response) {
    if(callback) try{callback(response.res, response.err, response.info.version)}catch(e){console.error("Error in user's uploadFile callback:",e);throw e;};
  });
  filestream.pipe(stream);
  return ident;
}
Hyperyun._Hyperstore.prototype.forceFind = function(collection, find_id, callback){
  var self = this;
  var findList = self.collectionFindLists[collection]?self.collectionFindLists[collection]:{};
  var view = findList[find_id];
  if(view){
    _.forEach(view.query.callback,function(func){
      self._find(collection, view.query.selector, view.query.options, func,{doNotPushCallback:true, checkview:true, forceRemote:true, forceLocal:false});
    })
    return true;
  }
  return false;
}
Hyperyun._Hyperstore.prototype.closeFind = function(collection, find_id, callback){
  var self = this;
  var findList = self.collectionFindLists[collection]?self.collectionFindLists[collection]:{};
  if(!find_id) return false;
  if(!findList) {
    console.error("Closing find on ",collection,"failed: not such collection",findList)
    return false;
  }
  if(findList[find_id]){
    var oldfind = findList[find_id];
    self.socket.emit('unsubscribeFromQuery',{sel:oldfind.selector, opt:oldfind.options},function(){});
    delete findList[find_id];
    if(callback)try{callback(oldfind)}catch(e){console.error("Error in user's closeFind callback:",e);throw e;};
    return oldfind;
  }
  else
    if(callback)try{callback(false)}catch(e){console.error("Error in user's closeFind callback:",e);throw e;};
  return false;
}
Hyperyun._Hyperstore.prototype._getAppOwnerTargets = function(collection, identifier,password,callback){
  var self = this;
  self.socket.emit('queryAppOwnerTargets',
    {
      appName: self.appName, 
      loginApp: self._getLoginApp(), 
      loginToken: self.loginToken, 
      version: self.version, 
      socketid: self.socketID, 
      eventOrigination: new Date(),
      presented_id:{
        identifier:identifier,
        password:password
      }
    },
    function(res){
      if(res && callback)
        try{callback(res.res,res.err,res.info);}catch(e){console.error("Error in user's _getAppOwnerTargets callback:",e);throw e;};
    })
}
Hyperyun._Hyperstore.prototype._chmod = function(collection, topLevelSelector, permissionString, options, callback){
  var self = this;
  //Multisignature
  //recursiveSelector, permissionString, omitFieldToSet,
  if(arguments.length == 4 && _.isFunction(options)){
    callback = options;
    options = {}
  }
  if(options === undefined) options = {};
  var recursiveSelector = options.recursiveSelector
  var omitFieldToSet = options.omitFieldToSet

  self.socket.emit('chmod',
  {
    collection: collection,
    appName: self.appName,
    loginApp: self._getLoginApp(),
    loginToken: self.loginToken,
    version: self.version,
    socketid: self.socketID,
    eventOrigination: new Date(),
    sel: topLevelSelector,
    opt:{
      recursiveSelector: recursiveSelector,
      omitFieldToSet: omitFieldToSet,
      permissionString: permissionString
    }
  },function(res){if(callback)try{callback(res)}catch(e){console.error("Error in user's chmod callback:",e);throw e;};})
}
Hyperyun._Hyperstore.prototype._applyChmod = function(collection, sel, opt,callback){
  var self = this;
  var topLevelSelector = sel
  var recursiveSelector = opt.recursiveSelector
  var matcher = new mongoMatcher(recursiveSelector)
  var code = opt.code
  var omitFieldToSet = opt.omitFieldToSet
  var applicant = opt.applicant
  var matched = self.LocalCollections[collection].find(sel,opt).fetch()
  _.forEach(matched, function(doc){
    var modifier= {$set:{}}
    function perDoc(level,path){
      if(path == undefined) path = ""
      if(matcher.discern(level)){
        if(level.bw_doc && level.bw_doc.owner_id && level.bw_doc.owner_id != applicant)
          return; //kick out if we aren't asset owner: we aren't allowed to set permissions
        if(!level.bw_doc || (level.bw_doc && !level.bw_doc.owner_id))
          return; //no permissions existant?
        var setPath = path+(path==""?"":".")+"bw_doc.";
        setPath += (omitFieldToSet && _.isString(omitFieldToSet) && omitFieldToSet != "" && omitFieldToSet[0] != ".")?
          "omits."+omitFieldToSet : "permissions"
        modifier["$set"][setPath] = code
      }
    }
    if(_.isFunction(recursiveSelector))
      self._recurseApply(doc, perDoc)
    else
      perDoc(doc)

    if(!_.isEqual(modifier["$set"],{}))
      self.LocalCollections[collection].update({_id:doc._id},modifier,opt);
  })
}

Hyperyun._Hyperstore.prototype._retrieveLoginCredentials = function(){
  var self = this;
  if(self.cookie && document && document.cookie){
    //find appNames
    var raw = document.cookie;
    var kvPairs = raw.split(';');
    var keys = _.compact(_.map(kvPairs,function(pair){
      var split = pair.split("=")
      if(_.size(split)>0)
        return pair.split("=")[0]
    }))
    var cookieapps = _.compact(_.map(keys,function(key){
      var x = key.indexOf("-HyperyunToken");
      if(x > 0) {
        try{
          var credential = {
            app : key.substr(0,x),
            cred : JSON.parse(cookie.get(key)),
            method : JSON.parse(cookie.get(key.substr(0,x)+"-HyperyunMethod")).method
          }
          return credential;
        } catch(e){
          console.error("Error parsing cookie token:",e);
          return undefined;
        }
      }
      else return undefined
    }))
  }
  if(localStorage && localStorage.key && localStorage.getItem){
    var localapps = [];
    for ( var i = 0, len = localStorage.length; i < len; ++i ) {
      var key = localStorage.key(i);
      var x = key.indexOf("-HyperyunToken");
      if(x > 0) {
        try{
          var credential = {
            app : key.substr(0,x),
            cred : JSON.parse(localStorage.getItem(key)),
            method : JSON.parse(localStorage.getItem(key.substr(0,x)+"-HyperyunMethod")).method
          }
          localapps.push(credential);
        } catch(e){
          console.error("Error parsing localStorage token:",e);
        }
      }
      else console.log(key,"is not a hyperyunToken key in localStorage")
    }
    localapps = _.compact(localapps);
  }
  return _.union(localapps?localapps:[], cookieapps?cookieapps:[]);
}

//Hyperstore.messages.subscribe({}).on('insert', function(a,b){ //do stuff})
//==
//Hyperstore.messages.find({},{disableLocalStoringOfStuff:true}).on('insert', function(a,b){ //do stuff})
Hyperyun._Hyperstore.prototype.subscribe = function(collection, selector, options, callback){
  if(selector == undefined) selector = {};
  if(options == undefined || !_.isPlainObject(object)) options = {};

  var self = this;
  return self._find(collection, selector, _.extend(options,{reactive:true}), function(){}, {noMinimongo:true})
}

//Hyperstore.messages.emit({object:"lol"});
//==
//Hyperstore.messages.insert({object:"lol"},{disableLocalStoringOfStuff:true})
Hyperyun._Hyperstore.prototype.emit = function(collection, event, payload, options, callback){
  if(event == undefined) return;
  if(options == undefined || !_.isPlainObject(object)) options = {};

  var self = this;
  var selector = {
    event : event,
    payload : payload
  }
  return self.insert(collection, selector, _.extend(options,{noMinimongo:true}), callback)
}
//  ██╗  ██╗███████╗██╗     ██████╗ ███████╗██████╗
//  ██║  ██║██╔════╝██║     ██╔══██╗██╔════╝██╔══██╗
//  ███████║█████╗  ██║     ██████╔╝█████╗  ██████╔╝
//  ██╔══██║██╔══╝  ██║     ██╔═══╝ ██╔══╝  ██╔══██╗
//  ██║  ██║███████╗███████╗██║     ███████╗██║  ██║
//  ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝
Hyperyun._Hyperstore.prototype.performQueryHealthCheck = function(collection){
  var self = this;
  self._checkViews(collection, 'forceInterrogation');
}
Hyperyun._Hyperstore.prototype.manuallyMaintainUserAlias = function(new_user){
  if(this.bruteUserAliasEnabled)
  {
    _.forEach(this.bruteUserAliasEnabled, function(ref){
      ref.user = new_user;
    })
  }
}
Hyperyun._Hyperstore.FindInstance = function(collection, hyperstore, uid){
  var self = this;
  self.assoc_hyperstore = hyperstore
  self.collection = collection;
  self.uid = uid;
  self.events = {};
}
Hyperyun._Hyperstore.FindInstance.prototype.force = function(){
  var self = this;
  if(!self.stored)//only forceFind if we aren't in a dormant state
    self.assoc_hyperstore.forceFind(self.collection,self.uid);
  else
    console.warn("Warning: force() may not be called on finds that are paused. Call resume() first");
}
Hyperyun._Hyperstore.FindInstance.prototype.close = function(callback){
  var self = this;
  self.assoc_hyperstore.closeFind(self.collection, self.uid, callback)
}
Hyperyun._Hyperstore.FindInstance.prototype.pause = function(){
  var self = this;
  self.stored = self.assoc_hyperstore.closeFind(self.collection, self.uid)
}
Hyperyun._Hyperstore.FindInstance.prototype.resume = function(){
  var self = this;
  if(self.stored)
  {
    self.assoc_hyperstore.collectionFindLists[self.collection][self.uid] = self.stored
    self.stored = undefined;
  }
}
Hyperyun._Hyperstore.FindInstance.prototype.on = function(event, cb){
  var self = this;
  var listRef = self.assoc_hyperstore.collectionFindLists[self.collection][self.uid]
  if(listRef){
    if(listRef.events == undefined) listRef.events = {};
    if(listRef.events[event] == undefined) listRef.events[event] = [];
    if(_.isFunction(cb)) listRef.events[event].push(cb);
  } else throw "ERROR for ON: FindInstance doesn't exist in collectionFindLists"
  return self;
}
Hyperyun._Hyperstore.FindInstance.prototype.trigger = function(event,info,cb){
  var self = this;
  var listRef = self.assoc_hyperstore.collectionFindLists[self.collection][self.uid]
  if(listRef && listRef.events && listRef.events[event]){
    _.forEach(listRef.events[event], function(ecb){
      if(_.isFunction(ecb)) 
        ecb(info)
    })
  }
}
//  Subroutines
Hyperyun._Hyperstore.prototype._queryIsStrictSubsetOfFindListQuery = function (collection, queryToCheck){
  var that = this;
  var findList = that.collectionFindLists[collection]?that.collectionFindLists[collection]:{};
  return _.some(findList, function(view){
    var comparand = view.query;
    //Case: different options, so give up. TODO: we can do more here
    if(!_.isEqual(queryToCheck.options, comparand.options))
    {
      togglelog("different options :(",'subset');return false;
    }
    //Case: duplicate
    if(_.isEqual(queryToCheck.selector,comparand.selector))
    {
      togglelog("duplicate selector :)",'subset');return true;
    }
    //Case: {} case
    if(_.isEqual(comparand.selector, {}))
    {
      togglelog("selector is {} :)",'subset');return true;
    }
    //Case: Super simplistic field query queries subset of fields
    if(_.isEqual(_.difference(_.keys(comparand.selector),_.keys(queryToCheck.selector)),[]) //keys are subset
      && !_.some(_.keys(_.union(queryToCheck.selector,comparand.selector)), function(v,k){return hyperstore_utils.isMongoOperator(k)}) //keys aren't keywords
      && _.every(comparand.selector, function(val,key){return _.isEqual(val,queryToCheck.selector[key])})//comparand is at least as specific as us
      )
    {
      togglelog("strict selector subset :)",'subset');return true;
    }
    //Default: As always, be a bit conservative and assume we need remote if we don't know better
    togglelog("Unable to determine :(",'subset');
    return false;
  });
}
Hyperyun._Hyperstore.prototype._recursiveWrapQuery = function(query, disableAutoFlagging, parentKey){
  var self = this;
  var disallowDocInsertionInKeyword = ['$addToSet','$push']//TODO: figure out other keywords that get messed up by _doc insertion
  /*
      We don't want to wrap objects that are not 'data': {$set: {foo:'bar'}} should
      be wrapped into {$set: {foo:'bar',_doc:{...}}}, instead of adding document data
      as in {$set: {foo: 'bar',_doc:{...}}, _doc:{...}} to the $set-associated object.
   */
  var objectIsMongoAction = false;
  if(_.find(query,function(v,k){
    if(hyperstore_utils.isMongoOperator(k)) return true;
  })) objectIsMongoAction = true;

  if(self._isHyperDoc(query))
  {
    //don't modify existing hyperdoc specs
    if(_.isString(query.bw_doc.permissions))
    {
      query.bw_doc.permissions = permissionCode.fromString(query.bw_doc.permissions)
    }
    else if(_.isObject(query.bw_doc.permissions)){
      query.bw_doc.permissions = permissionCode.encodePermission(query.bw_doc.permissions)
    }
  }
  
  _.forEach(_.keys(query), function(key){
    var val = query[key];
    if(key == "bw_doc") return;//bw_doc objects... are bw_doc objects :P
    if(_.isFunction(val))
    {
      //do nothing: functions are 'objects' but we do not wish to wrap them
    }
    else if(_.isArray(val) && !_.isString(val))
    {
      //Arrays are objects, but need to be handled differently
      val = _.map(val, function(v,k){
        if(_.isObject(v) && !_.isString(v))
          return self._recursiveWrapQuery(v,disableAutoFlagging,k);
        else
          return v;
      })
      query[key] = val;
    }
    else if(_.isObject(val))
    {
      //Default interest case
      val = self._recursiveWrapQuery(val,disableAutoFlagging,key);
      query[key] = val;
    }
    else
    {
      //We do not wrap numbers, strings, booleans, null/undefined/NaN, etc
    }
  })

  if(!self._isHyperDoc(query) && !self._isHyperLink(query) && !objectIsMongoAction && !_.contains(disallowDocInsertionInKeyword,parentKey))
  {
    query = self.hyperDoc(query)
    if(!disableAutoFlagging)
      query.bw_doc.auto = true;
  }

  return query;
}
Hyperyun._Hyperstore.prototype._isHyperDoc = function(object){
  return object && object.bw_doc && object.bw_doc.object_type == 'Basic'
}
Hyperyun._Hyperstore.prototype._isHyperLink = function(object){
  return object && object.bw_doc && object.bw_doc.object_type == 'Symlink'
}
Hyperyun._Hyperstore.prototype.hyperLink = function(object){
  var _wrapLink = function(contents, docSettings){
    if(!contents) contents = {};
    contents.bw_doc = {
      createdAt: new Date(),
      modifiedAt: new Date(),
      owner_id: false,
      object_type: 'Symlink'
    }
    if(docSettings)
    {
      contents.bw_doc = _.extend(contents.bw_doc,docSettings);
    }
    return contents;
  }
  var self = this;
  if(!object) object = {}
  //copy object and wrap it
  return _wrapLink(_.extend({},object),{owner_id:self.user._id});
}
Hyperyun._Hyperstore.prototype.hyperDoc = function(object)
{
  var self = this;
  var _wrapObject = function(contents, docSettings){
    if(!contents) contents = {};
    contents.bw_doc = {
      createdAt: new Date(),
      modifiedAt: new Date(),
      owner_id: self.user_id,
      object_type: 'Basic',
      //default to making this data public
      permissions:permissionCode.encodePermission({
        owner:['r','w','e'],
        group:['r','w','e'],
        public:['r','w','e']
      })
    }
    if(docSettings)
    {
      contents.bw_doc = _.extend(contents.bw_doc,docSettings);
    }
    return contents;
  }
  if(!object) object = {}
  //copy object and wrap it
  return _wrapObject(_.extend({},object),{owner_id:self.user?self.user._id:false});
}
Hyperyun._Hyperstore.prototype._getLoginApp = function(){
  var self = this;
  return self.loginApp;
}
Hyperyun._Hyperstore.prototype._execGetUserCallbacks = function(collection, user, origin) {
  var self = this;
  _.each(self.collectionUserCallbacks,function(k,collection){
    for(var i = 0; i < _.size(self.collectionUserCallbacks[collection]); i ++){
      if(typeof self.collectionUserCallbacks[collection][i] == 'function')
      {
        self.collectionUserCallbacks[collection][i](user);
      }
    }
  })
}
Hyperyun._Hyperstore.prototype._registerGetUserCallback = function(collection, callback){
  togglelog("registering get user callback");
  var self = this;
  if(!callback) return;
  self.collectionUserCallbacks[collection].push(callback);
}
Hyperyun._Hyperstore.prototype._checkLogin = function(callback) {
  var that=this;
  var token = null;
  if(that.loginToken && that._retrieveValueFromLocalStorage(that.cookieName))
    {
      toggleinfo("Using localStorage token",'cookie'); 
      token = that.loginToken;
    }
  else if(that.cookie) token = that.cookie.get(that.cookieName);
  that.socket.emit('loggedIn', {appName: that.appName, loginToken: token, eventOrigination: new Date()}, function(res) {
    if(res.err) {
      togglewarn(res.err);
      callback(null);
    } else {
      that.reconnectTables = res.reconnects;
      that.disconnectStrategy = res.disconnectModificationStrategy;
      that.defaultDisconnectStrategy = res.defaultDisconnectStrategy;
      callback(that.user);//trueres.res);
    }
  });
}
Hyperyun._Hyperstore.prototype._renderData = function(collection, data) {
  if(typeof document != 'undefined') {
    var dataCollection = document.querySelector('*[data-hyperyun-collection="'+collection+'"]');
    var dataEach = document.querySelector('*[data-hyperyun-collection="'+collection+'"] *[data-hyperyun-each]');
    if(dataEach) {
      var temp = new Array();
      dataCollection.innerHTML="";
      for (var i = 0; i < data.length; i++) {
        temp[i] = dataEach.cloneNode(true);
        var entry = data[i];
        for (key in entry)
        {
          var dataField = temp[i].querySelector('*[data-hyperyun-field="'+key+'"]');
          if(dataField)
            dataField.textContent=entry[key];
        }
        dataCollection.appendChild(temp[i]);
      };
    } else {
      for (key in data)
      {
        var dataField = document.querySelector('*[data-hyperyun-collection="'+collection+'"] *[data-hyperyun-field="'+key+'"]');
        if(dataField)
          dataField.textContent=data[key];
      }
    }
  }
};
Hyperyun._Hyperstore.prototype._renderAll = function(collection) {
  var that = this;
	var findList = that.collectionFindLists[collection]?that.collectionFindLists[collection]:{};
  var goOver = function(collection){
  _.each(findList, function(view, index){
      if(view.query.callback)
        {
          toggleinfo("rerendering view callback "+view.uid+" ("+JSON.stringify(view.query.selector)+")",'render');
          var results = that.LocalCollections[collection].find(view.query.selector,view.query.options).fetch();
        }
    });
  }

  if(collection)
    goOver(collection)
  else
    _.each(that.collectionFindLists, function(coll){goOver(collection)});
};

Hyperyun._Hyperstore.prototype.ObjectID = function(hex, callback) {
  var oid = new LocalCollection._ObjectID(hex);
  if(callback) callback(oid);
  return oid;
};

Hyperyun._Hyperstore.prototype._unstashFromLocalStorage = function(collection, callback){
  var that = this;
  that.collectionFindLists[collection] = {}
  that.LocalCollections[collection] = new LocalCollection();
  if(callback)callback({res: collection, err: null});
  return;

}
Hyperyun._Hyperstore.prototype._storePairToLocalStorage = function(key, val)
{

  toggleinfo("Setting Pair "+key+" : "+JSON.stringify(val),'localStorage');
  if(!hyperstore_utils.supportsLocalStorage())
  {
    togglewarn("Failed to store pair to local storage: HTML5 storage not available.",'localStorage');
    return false;
  }
  return localStorage.setItem(key, JSON.stringify(val));
}
Hyperyun._Hyperstore.prototype._retrieveValueFromLocalStorage = function(key){
  if(!hyperstore_utils.supportsLocalStorage())
  {
    togglewarn("Failed to retrieve value from local storage: HTML5 storage not available.",'localStorage');
    return false;
  }
  try
  {
    togglelog("Retrieving pair "+JSON.parse(localStorage.getItem(key)),'localStorage');
    return JSON.parse(localStorage.getItem(key));
  } catch(e){return localStorage.getItem(key)}
}
Hyperyun._Hyperstore.prototype._removeValueFromLocalStorage = function(key){
  if(!hyperstore_utils.supportsLocalStorage())
  {
    togglewarn("Failed to remove value from local storage: HTML5 storage not available.",'localStorage');
    return false;
  }
  localStorage.removeItem(key);
}
Hyperyun._Hyperstore.prototype._forceReconnectSideEffects = function(collection){
  var that = this;
  if(that.disconnectStrategy[collection] == 0 || that.defaultDisconnectStrategy == 0)
  {
    //disallow
    that.queue.length = 0;
    that.events.reconnect([]);
    that.trigger(collection,'reconnect',[]);
  }
  else if(that.disconnectStrategy[collection] == 2 || that.defaultDisconnectStrategy == 2)
  {
    //expose to dev
    that.events.reconnect(that.queue);
    that.trigger(collection,'reconnect',that.queue);
  }
  else
  {
    //execute queue
    that._execQueue();
    that.events.reconnect([]);
    that.trigger(collection,'reconnect',[]);
  }
}
Hyperyun._Hyperstore.prototype._execQueue = function() {
  var that=this;
  if(!that.queue.length) {
    return true;
  } else {
    that.queue[0](function (finish) {
      if(finish) that.queue.splice(0, 1);
      that._execQueue();
      return true;
    });
  }
}
Hyperyun._Hyperstore.prototype._getAllSubKeys = function(query, depth, depthLimit)
{
  if(!depth) depth = 0;
  if(!depthLimit) depthLimit = 10;
  var that = this;
  if(depth > depthLimit) return [];//Queries shouldn't be so deep as to cause us recursive worries
  if(typeof query ==='object')
  {
    var keys = _.map(_.keys(query), function(key){
      return key.replace(/\"([^(\")"]+)\"/,"$1");
    });
    //Handle 'dots'
    var dotkeys = _.filter(keys, function(key){
      return _.size(key.split("."))>0;
    })
    var dottedkeys = new Array();
    for(var i = 0; i < _.size(dotkeys); i++)
    {
      dottedkeys.push(dotkeys[i].split("."))
    }
    keys = _.union(keys, _.flatten(dottedkeys));
    var result = _.filter(keys, function(key){
      if(key.charAt(0) == "$") return false;
      return true;
    });
    _.each(query, function(val, key){
      if(typeof val === 'object')//only recurse if it'd be fruitful to do so
      {
        result = _.union(result,that._getAllSubKeys(val,depth+1,depthLimit))
      }
    });
    return result;
  }
  else
  {
    return [];//literal was passed to us as a query, ignore
  }
}
Hyperyun._Hyperstore.prototype._recurseApply = function(obj, fnEachLevel, path){
  if(!_.isString(path)) path = ""
  if(_.isPlainObject(obj) || _.isArray(obj))
    _.forEach(obj,function(e,k){
        Hyperyun.Utils.recurseApply(e, fnEachLevel,path+(path==""?"":".")+k)
    })
  obj = fnEachLevel(obj,path);
  return obj
}
//  ██╗   ██╗████████╗██╗██╗     ███████╗
//  ██║   ██║╚══██╔══╝██║██║     ██╔════╝
//  ██║   ██║   ██║   ██║██║     ███████╗
//  ██║   ██║   ██║   ██║██║     ╚════██║
//  ╚██████╔╝   ██║   ██║███████╗███████║
//   ╚═════╝    ╚═╝   ╚═╝╚══════╝╚══════╝
//
var toggleLogExclusionSet = ['find','render','cache',/*'reactive',*/,'subset','localStorage','reactive'];
function togglelog(object,subset)
{
  if(toggleLogExclusionSet == 'totalSilence')return;
  if(!subset) subset = '';
  if(_.contains(toggleLogExclusionSet, subset))
    return;
  console.log(object);
}
function toggleinfo(object,subset)
{
  if(toggleLogExclusionSet == 'totalSilence')return;
   if(!subset) subset = '';
  if(_.contains(toggleLogExclusionSet, subset))
    return;
  console.info(object);
}
function togglewarn(object,subset)
{
  if(toggleLogExclusionSet == 'totalSilence')return;
   if(!subset) subset = '';
  if(_.contains(toggleLogExclusionSet, subset))
    return;
  console.warn(object);
}
//This useful recursive function will omit key values where the fnDet function isn't satisfied. 
//  fnDet is passed the bw_doc for the current level, and must return a boolean value (false = prune, true = retain)
//  fnTran is passed the bw_doc for the current level and the field key being considered for transform (false = omit, true = recurse)
function recursiveCensor(document, fnDet, fnTran){
  if(_.isPlainObject(document))
  {
    if(!document.bw_doc || !fnDet || (document.bw_doc && fnDet(document.bw_doc)))
    {
      var transformed = _.transform(document,function(result,v,k){
        if(!fnTran || (fnTran && fnTran(document.bw_doc,k)))
          result[k] = recursiveCensor(v,fnDet,fnTran)
      });
      return transformed
    }
    else return undefined;
  }
  else if(_.isArray(document))
    return _.map(document, function(ele){return recursiveCensor(ele, fnDet, fnTran)});
  else
    return document;
}
function censorBW_Doc(document){
  return recursiveCensor(document,
    undefined,//no branch pruning
    function(bw_doc,k){return k != "bw_doc"}//omit bw_doc fields
    )
}

this.Hyperyun = Hyperyun;
this.Hyperstore = Hyperyun.Hyperstore;
};

if(typeof module != 'undefined') module['exports'] = init;
init();