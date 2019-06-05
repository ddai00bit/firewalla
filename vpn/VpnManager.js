/*    Copyright 2016 Firewalla LLC 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

var instance = null;
const log = require("../net2/logger.js")(__filename)
const iptable = require("../net2/Iptables");
const wrapIptables = iptable.wrapIptables;
const exec = require('child_process').exec
const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager('info');
const firewalla = require('../net2/Firewalla.js');
const fHome = firewalla.getFirewallaHome();

const fs = require('fs');

const sem = require('../sensor/SensorEventManager.js').getInstance();
const util = require('util');

const pclient = require('../util/redis_manager.js').getPublishClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const UPNP = require('../extension/upnp/upnp.js');

module.exports = class {
  constructor() {
    if (instance == null) {
      this.upnp = new UPNP(sysManager.myGateway());
      if (firewalla.isMain()) {
        sclient.on("message", async (channel, message) => {
          switch (channel) {
            case "System:IPChange":
              // update SNAT rule in iptables
              try {
                await this.setIptables()
              } catch(err) {
                log.error("Failed to set iptables", err);
              }
            default:
          }
        });

        sclient.subscribe("System:IPChange");
      }
      instance = this;
    }
    return instance;
  }

  async setIptables() {
    const serverNetwork = this.serverNetwork;
    const localIp = sysManager.myIp();
    this._currentLocalIp = localIp;
    if (!serverNetwork) {
      return;
    }
    log.info("VpnManager:SetIptables", serverNetwork, localIp);

    const commands =[
      // delete this rule if it exists, logical opertion ensures correct execution
      wrapIptables(`sudo iptables -w -t nat -D POSTROUTING -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp}`),
      // insert back as top rule in table
      `sudo iptables -w -t nat -I POSTROUTING 1 -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp}`
    ];
    await iptable.run(commands);
  }

  async unsetIptables() {
    const serverNetwork = this.serverNetwork;
    let localIp = sysManager.myIp();
    if (this._currentLocalIp)
      localIp = this._currentLocalIp;
    if (!serverNetwork) {
      return;
    }
    log.info("VpnManager:UnsetIptables", serverNetwork, localIp);
    const commands = [
      wrapIptables(`sudo iptables -w -t nat -D POSTROUTING -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp}`),
    ];
    this._currentLocalIp = null;
    await iptable.run(commands);
  }

  removeUpnpPortMapping(opts, callback) {
    log.info("VpnManager:RemoveUpnpPortMapping", opts);
    let timeoutExecuted = false;
    const timeout = setTimeout(() => {
      timeoutExecuted = true;
      log.error("Failed to remove upnp port mapping due to timeout");
      if (callback) {
        callback(new Error("Timeout"));
      }
    }, 10000);
    this.upnp.removePortMapping(opts.protocol, opts.private, opts.public, (err) => {
      clearTimeout(timeout);
      if (callback && !timeoutExecuted) {
        callback(err);
      }
    });
  }

  addUpnpPortMapping(protocol, localPort, externalPort, description, callback) {
    log.info("VpnManager:AddUpnpPortMapping", protocol, localPort, externalPort, description);
    let timeoutExecuted = false;
    const timeout = setTimeout(() => {
      timeoutExecuted = true;
      log.error("Failed to add upnp port mapping due to timeout");
      if (callback) {
        callback(new Error("Timeout"));
      }
    }, 10000);
    this.upnp.addPortMapping(protocol, localPort, externalPort, description, (err) => {
      clearTimeout(timeout);
      if (callback && !timeoutExecuted) {
        callback(err);
      }
    });
  }

  install(instance, callback) {
    let install1_cmd = util.format('cd %s/vpn; sudo -E ./install1.sh %s', fHome, instance);
    exec(install1_cmd, (err, out, code) => {
      if (err) {
        log.error("VPNManager:INSTALL:Error", "Unable to install1.sh for " + instance, err);
      }
      if (err == null) {
        // !! Pay attention to the parameter "-E" which is used to preserve the
        // enviornment variables when running sudo commands
        const installLockFile = "/dev/shm/vpn_install2_lock_file";
        let install2_cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./install2.sh %s'; sync", fHome, installLockFile, instance);
        log.info("VPNManager:INSTALL:cmd", install2_cmd);
        exec(install2_cmd, (err, out, code) => {
          if (err) {
            log.error("VPNManager:INSTALL:Error", "Unable to install2.sh", err);
            if (callback) {
              callback(err, null);
            }
            return;
          }
          log.info("VPNManager:INSTALL:Done");
          this.instanceName = instance;
          if (callback)
            callback(null, null);
        });
      } else {
        if (callback)
          callback(err, null);
      }
    });
  }

  configure(config, needRestart, callback) {
    if (config) {
      if (config.serverNetwork) {
        this.serverNetwork = config.serverNetwork;
      }
      if (config.localPort) {
        this.localPort = config.localPort;
      }
    }
    if (this.serverNetwork == null) {
      this.serverNetwork = this.generateNetwork();
    }
    if (this.localPort == null) {
      this.localPort = "1194";
    }
    if (this.instanceName == null) {
      this.instanceName = "server";
    }
    if (needRestart === true) {
      this.needRestart = true;
    }
    var mydns = sysManager.myDNS()[0];
    if (mydns == null) {
      mydns = "8.8.8.8"; // use google DNS as default
    }
    const confGenLockFile = "/dev/shm/vpn_confgen_lock_file";
    const cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./confgen.sh %s %s %s %s %s'; sync",
      fHome, confGenLockFile, this.instanceName, sysManager.myIp(), mydns, this.serverNetwork, this.localPort);
    log.info("VPNManager:CONFIGURE:cmd", cmd);
    exec(cmd, (err, out, code) => {
      if (err) {
        log.error("VPNManager:CONFIGURE:Error", "Unable to generate server config for " + this.instanceName, err);
        if (callback)
          callback(err);
        return;
      }
      log.info("VPNManager:CONFIGURE:Done");
      if (callback)
        callback(null);
    });
  }

  stop(callback) {
    callback = callback || function(){};
    this.started = false;
    this.removeUpnpPortMapping({
      protocol: 'udp',
      private: this.localPort,
      public: this.localPort
    });
    exec("sudo systemctl stop openvpn@" + this.instanceName, async (err, out, code) => {
      log.info("Stopping OpenVpn", err);
      if (err) {
        callback(err);
      } else {
        try {
          await this.unsetIptables()
        } catch(e) {
          callback(e);
          return
        }
        callback();
      }
    });
  }

  start(callback) {
    callback = callback || function(){};

    // check whatever VPN server is running or not
    sem.sendEventToFireMain({
      type: "PublicIP:Check",
      message: "VPN server starting, check public IP"
    })

    if (this.started && !this.needRestart) {
      log.info("VpnManager::StartedAlready");
      callback(null, this.portmapped, this.portmapped, this.serverNetwork, this.localPort);
      return;
    }

    if (this.instanceName == null) {
      callback("Server instance is not installed yet.");
      return;
    }

    this.upnp.gw = sysManager.myGateway();

    this.removeUpnpPortMapping({
      protocol: 'udp',
      private: this.localPort,
      public: this.localPort
    }, (err) => {
      let op = "start";
      if (this.needRestart) {
        op = "restart";
        this.needRestart = false;
      }
      exec(
        util.format("sudo systemctl %s openvpn@%s", op, this.instanceName),
        async (err, out, stderr) => {
          log.info("VpnManager:Start:" + this.instanceName, err);
          if (err && this.started == false) {
            callback(err);
            return;
          }
          this.started = true;
          try {
            await this.setIptables()
          } catch(err) {
            log.error("VpnManager:Start:Error", "Failed to set iptables", err);
            this.stop();
            callback(err);
            return
          }
          this.addUpnpPortMapping("udp", this.localPort, this.localPort, "Firewalla OpenVPN", (err) => { // public port and private port is equivalent by default
            log.info("VpnManager:UPNP:SetDone", err);
            pclient.publishAsync("System:VPNSubnetChanged", this.serverNetwork + "/24");
            /*
            sem.emitEvent({
                type: "VPNSubnetChanged",
                message: "VPN subnet is updated",
                vpnSubnet: this.serverNetwork + "/24",
                toProcess: "FireMain"
            });
            */
            if (err) {
              callback(null, null, null, this.serverNetwork, this.localPort);
            } else {
              this.portmapped = true;
              callback(null, "success", this.localPort, this.serverNetwork, this.localPort);
            }
          });
        }
      );
    });
  }

  generatePassword(len) {
    var length = len,
      charset = "0123456789",
      retVal = "";
    for (var i = 0, n = charset.length; i < length; ++i) {
      retVal += charset.charAt(Math.floor(Math.random() * n));
    }
    return retVal;
  }

  generateNetwork() {
    // random segment from 20 to 199
    const seg1 = Math.floor(Math.random() * 180 + 20);
    const seg2 = Math.floor(Math.random() * 180 + 20);
    return "10." + seg1 + "." + seg2 + ".0";
  }

  getOvpnFile(clientname, password, regenerate, compressAlg, callback) {
    let ovpn_file = util.format("%s/ovpns/%s.ovpn", process.env.HOME, clientname);
    let ovpn_password = util.format("%s/ovpns/%s.ovpn.password", process.env.HOME, clientname);
    if (compressAlg == null)
      compressAlg = "";

    log.info("Reading ovpn file", ovpn_file, ovpn_password, regenerate);

    fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
      if (ovpn != null && regenerate == false) {
        let password = fs.readFileSync(ovpn_password, 'utf8');
        log.info("VPNManager:Found older ovpn file: " + ovpn_file);
        callback(null, ovpn, password);
        return;
      }

      let originalName = clientname;
      // Original name remains unchanged even if client name is trailed by random numbers.
      // So that client ovpn file name will remain unchanged while its content has been updated.
      if (regenerate == true) {
        clientname = clientname + this.generatePassword(10);
      }

      if (password == null) {
        password = this.generatePassword(5);
      }

      let ip = sysManager.myDDNS();
      if (ip == null) {
        ip = sysManager.publicIp;
      }

      var mydns = sysManager.myDNS()[0];
      if (mydns == null) {
        mydns = "8.8.8.8"; // use google DNS as default
      }

      const vpnLockFile = "/dev/shm/vpn_gen_lock_file";

      let cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./ovpngen.sh %s %s %s %s %s %s'; sync",
        fHome, vpnLockFile, clientname, password, ip, this.localPort, originalName, compressAlg);
      log.info("VPNManager:GEN", cmd);
      this.getovpn = exec(cmd, (err, out, code) => {
        if (err) {
          log.error("VPNManager:GEN:Error", "Unable to ovpngen.sh", err);
        }
        fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
          if (callback) {
            callback(err, ovpn, password);
          }
        });
      });
    });
  }
}
