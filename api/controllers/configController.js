'use strict';

const https = require('https');
const http = require('http');
var colors = require('colors/safe');


var configModule = require(__basedir + 'api/modules/configModule');

var prevAlgos={};
var profitTimer={};

Array.prototype.contains = function(element){
  return this.indexOf(element) > -1;
};

function getConfig(req, res, next) {
  var obj=configModule.config;
  obj.algos=configModule.configNonPersistent.algos;
  obj.protocols=configModule.configNonPersistent.protocols;
  obj.regions=configModule.configNonPersistent.regions;
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(obj));
}
function setConfig(req, res, next) {
  configModule.setConfig(req.body);
  configModule.saveConfig();
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({result: true}));
}

function update(req, res, next) {
  const spawn = require('cross-spawn');
  const child = spawn('git',['pull'],{
      detached: true,
      stdio: 'ignore',
      shell:true
    });
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({result:true}));
}

function getAlgoForGroup(group){ //group is expected to be autoswitch-enabled
  var query={
    algos:{},
    region:group.region,
    name:group.name
  };

  //setup algos for group
  for(var i=0;i< configModule.config.entries.length;i++) {
    var entry = configModule.config.entries[i];
    if(entry.enabled&&entry.group===group.name){
      query.algos[entry.algo]={hashrate:0};
    }
  }

  //add hashrates of group devices
  for(var j=0;j< configModule.config.devices.length;j++) {
    var device = configModule.config.devices[j];
    if (device.enabled&&device.groups.contains(group.name)){
      for (var property in query.algos) {
        if (query.algos.hasOwnProperty(property)) {
          query.algos[property].hashrate+=device.hashrate;
        }
      }
    }
  }

  //multiply to get H/s for query
  for (var property in query.algos) {
    if (query.algos.hasOwnProperty(property)) {
      query.algos[property].hashrate*=1000*1000;
    }
  }

  //query optimal algo
  var arr = configModule.config.profitabilityServiceUrl.split(":");
  var req= http.request({
    host: arr[0],
    path: '/api/query',
    method: 'POST',
    port: arr[1],
    headers: {
      'Content-Type': 'application/json;charset=UTF-8'
    }
  }, function (response) {
    response.setEncoding('utf8');
    var body = '';
    response.on('data', function (d) {
      body += d;
    });
    response.on('end', function () {
      var parsed = null;
      try{
        parsed=JSON.parse(body);
      }catch(error){
        console.log(colors.red("["+group.name+"] Error: Unable to get profitability data"));
        console.log(error);
      }
      if (parsed != null){
        if (parsed.result!==false){

          var minerQuery={
            pools:[]
          };

          for(var i=0;i< configModule.config.entries.length;i++) {
            var entry = configModule.config.entries[i];
            if(entry.enabled&&entry.group===group.name&&entry.algo===parsed.result.algo){
              if(entry.appendWorker)
                minerQuery.pools.push({url:parsed.result.url,user:entry.username+".#APPEND#",pass:entry.password,priority:entry.prio,algo:entry.algo});
              else
                minerQuery.pools.push({url:parsed.result.url,user:entry.username,pass:entry.password,priority:entry.prio,algo:entry.algo});
              break;
            }
          }

          if(prevAlgos[group.name]!==undefined){
            if(prevAlgos[group.name]!==parsed.result.algo){
              //deploy new config
              for(var j=0;j< configModule.config.devices.length;j++) {
                var device = configModule.config.devices[j];
                if (device.enabled&&device.groups.contains(group.name)){
                  (function(device,minerQuery){
                    deployConfigToMiner(device,JSON.parse(JSON.stringify(minerQuery)));
                  })(device,minerQuery);
                }
              }
              prevAlgos[group.name]=parsed.result.algo;
            }
          }else{
            //startup
            for(var j=0;j< configModule.config.devices.length;j++) {
              var device = configModule.config.devices[j];
              if (device.enabled&&device.groups.contains(group.name)){
                (function(device,minerQuery){
                  deployConfigToMiner(device,JSON.parse(JSON.stringify(minerQuery)));
                })(device,minerQuery);
              }
            }
            prevAlgos[group.name]=parsed.result.algo;
          }

        }
      }else
        console.log(colors.red("["+group.name+"] Error: malformed profitability request"));
    });
  }).on("error", function(error) {
    console.log(colors.red("["+group.name+"] Error: Unable to get profitability data"));
    console.log(error);
  });
  req.write(JSON.stringify(query));
  req.end();
}

function deployAll(){
  if(configModule.config.groups!==undefined){
    for(var i=0;i< configModule.config.groups.length;i++) {
      var group = configModule.config.groups[i];
      if(profitTimer[group.id]!==undefined)
        clearInterval(profitTimer[group.id]);
      (function (group){
        if (group.enabled){
          if (group.autoswitch){
            if(configModule.config.profitabilityServiceUrl!==""&&configModule.config.profitabilityServiceUrl!==null&&configModule.config.profitabilityServiceUrl!==undefined){
              getAlgoForGroup(group);
              profitTimer[group.id]=setInterval(function(){
                getAlgoForGroup(group);
              },1000*60*group.interval);
            }else{
              console.log(colors.red("Error: profitability url not configured"));
            }
          }else{
            var query={
              pools:[]
            };
            for(var j=0;j< configModule.config.entries.length;j++) {
              var entry = configModule.config.entries[j];
              if (entry.enabled&&entry.group===group.name){
                if(entry.appendWorker)
                  query.pools.push({url:entry.stratum,user:entry.username+".#APPEND#",pass:entry.password,priority:entry.prio,algo:entry.algo});
                else
                  query.pools.push({url:entry.stratum,user:entry.username,pass:entry.password,priority:entry.prio,algo:entry.algo});
              }
            }
            for(var j=0;j< configModule.config.devices.length;j++) {
              var device = configModule.config.devices[j];
              if (device.enabled&&device.groups.contains(group.name)){
                (function(device,query){
                  deployConfigToMiner(device,JSON.parse(JSON.stringify(query)));
                })(device,query);

              }
            }
          }
        }
      })(group);
    }
  }
}

function deploy(req,res,next){
  deployAll();
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({result:true}));
}

function deployConfigToMiner(device,query){
  for(var i=0;i<query.pools.length;i++){
    query.pools[i].user=query.pools[i].user.replace("#APPEND#",device.name);
  }
  var arr = device.hostname.split(":");
  switch(device.protocol){
    case "http":
      var req= http.request({
        host: arr[0],
        path: '/f_settings.php?pools='+encodeURIComponent(JSON.stringify(query.pools)),
        method: 'GET',
        port: arr[1],
        headers: {
          'Content-Type': 'application/json;charset=UTF-8'
        }
      }, function (response) {
        response.setEncoding('utf8');
        var body = '';
        response.on('data', function (d) {
          body += d;
        });
        response.on('end', function () {
          //console.log(body);
        });
      }).on("error", function(error) {
        console.log(colors.red("["+device.name+"] Error: Unable to deploy config"));
        console.log(error);
      });
      req.end();
      break;
    case "https":
      var req= https.request({
        host: arr[0],
        path: '/f_settings.php?pools='+encodeURIComponent(JSON.stringify(query.pools)),
        method: 'GET',
        port: arr[1],
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json;charset=UTF-8'
        }
      }, function (response) {
        response.setEncoding('utf8');
        var body = '';
        response.on('data', function (d) {
          body += d;
        });
        response.on('end', function () {
          //console.log(body);
        });
      }).on("error", function(error) {
        console.log(colors.red("["+device.name+"] Error: Unable to deploy config"));
        console.log(error);
      });
      req.end();
      break;
  }
}

function init() {
  setTimeout(function(){
    deployAll();
  },5000);
}

init();

exports.getConfig = getConfig;
exports.setConfig = setConfig;
exports.update = update;
exports.deploy = deploy;
