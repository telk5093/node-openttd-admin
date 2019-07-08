/*This project is free software released under the MIT/X11 license:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.*/

var Buffers = require('buffers')
, binary  = require('binary')
, put  = require('put')
, net     = require('net')
, tcp_enum= require('./enums')
, adminPackets = tcp_enum.AdminPackets
, EventEmitter = require('events').EventEmitter
, parsers = require("./parsers")
;

var connection  = function (){
  return this;
};

connection.prototype = new EventEmitter;
connection.prototype.sock = false;
connection.prototype.buffer = Buffers();
connection.prototype.binaryStreamer = binary()

connection.prototype.makeEvent = function(eventName){
  var self = this;
  return function(data) {
    self.emit(eventName, data);
  };
}

connection.prototype.connect = function(server, port){
  var self = this;
  if (self.sock){
    return callback("Already connected", null);
  }

  self.sock = new net.Socket();
  self.sock.setNoDelay(true);

  self.sock.on("error", function(){
    self.error("connectionerror");
  });
  self.sock.on("close", function(){
    self.error("connectionclose");
  });
  self.sock.on("timeout", function(){
    self.error("connectiontimeout");
  });

  self.sock.on("connect", function(){
    self.emit("connect");
  });

  var parsePacket = function(buf) {
    binary.parse(buf)
      .word16le('pcktlen')
      .word8('pckttype')
      .tap(function(vars){
        switch(vars.pckttype){
          case adminPackets.SERVER_PROTOCOL:        parsers.protocol(this, self.makeEvent("authenticate"));         break;
          case adminPackets.SERVER_WELCOME:         parsers.welcome(this, self.makeEvent("welcome"));               break;
          case adminPackets.SERVER_FULL:            self.error("FULL");                                             break;
          case adminPackets.SERVER_BANNED:          self.error("BANNED");                                           break;
          case adminPackets.SERVER_NEWGAME:         self.emit('newgame');                                           break;
          case adminPackets.SERVER_SHUTDOWN:        self.emit('shutdown');                                          break;
          case adminPackets.SERVER_DATE:            parsers.date(this, self.makeEvent("date"));                     break;
          case adminPackets.SERVER_CLIENT_JOIN:     parsers.clientjoin(this, self.makeEvent("clientjoin"));         break;
          case adminPackets.SERVER_CLIENT_INFO:     parsers.clientinfo(this, self.makeEvent("clientinfo"));         break;
          case adminPackets.SERVER_CLIENT_UPDATE:   parsers.clientupdate(this, self.makeEvent("clientupdate"));     break;
          case adminPackets.SERVER_CLIENT_QUIT:     parsers.clientquit(this, self.makeEvent("clientquit"));         break;
          case adminPackets.SERVER_CLIENT_ERROR:    parsers.clienterror(this, self.makeEvent("clienterror"));       break;
          case adminPackets.SERVER_COMPANY_INFO:    parsers.companyinfo(this, self.makeEvent("companyinfo"));       break;
          case adminPackets.SERVER_COMPANY_UPDATE:  parsers.companyupdate(this, self.makeEvent("companyupdate"));   break;
          case adminPackets.SERVER_COMPANY_REMOVE:  parsers.companyremove(this, self.makeEvent("companyremove"));   break;
          case adminPackets.SERVER_COMPANY_ECONOMY: parsers.companyeconomy(this, self.makeEvent("companyeconomy")); break;
          case adminPackets.SERVER_COMPANY_STATS:   parsers.companystats(this, self.makeEvent("companystats"));     break;
          case adminPackets.SERVER_COMPANY_NEW:     parsers.companynew(this, self.makeEvent("companynew"));         break;
          case adminPackets.SERVER_CHAT:            parsers.chat(this, self.makeEvent("chat"));                     break;
          case adminPackets.SERVER_RCON:            parsers.rcon(this, self.makeEvent("rcon"));                     break;
          case adminPackets.SERVER_RCON_END:        parsers.rconend(this, self.makeEvent("rconend"));               break;
          case adminPackets.SERVER_CONSOLE:         parsers.console(this, self.makeEvent("console"));               break;
          case adminPackets.SERVER_PONG:            parsers.pong(this, self.makeEvent("pong"));                     break;
          case adminPackets.SERVER_ERROR:           //Special case
              this
                .word8('code')
                .tap(function(vars){
                  self.error(vars.code);
                });
              break;
          default:
            console.log('unhandled pckttype', vars.pckttype);
        }
      });
  };

  var parseData = function(buf) {
    if (self.packetBuffer === null)
    {
      self.packetBuffer = buf;
      self.packetLength = buf.readUInt16LE(0);
      buf = new Buffer(0);
    }

    if (self.packetBuffer.length + buf.length <= self.packetLength)
    {
      self.packetBuffer = Buffer.concat([ self.packetBuffer, buf ]);

      if (self.packetBuffer.length === self.packetLength)
      {
        parsePacket(self.packetBuffer);
        self.packetBuffer = null;
      }
      //else: wait for the next packet

      return false;
    }

    // if (self.packetBuffer.length + buf.length > self.packetLength)

    var check = Buffer.allocUnsafe(self.packetLength);
    self.packetBuffer.copy(check, 0, 0, self.packetLength);
    self.packetBuffer = self.packetBuffer.slice(self.packetLength);
    self.packetLength = self.packetBuffer.readUInt16LE(0);
    parsePacket(check);

    return true;
  };

  self.packetBuffer = null;
  self.packetLength = 0;

  self.sock.on("data", function(buf) {
    var temp = buf;
    while(parseData(temp))
      temp = new Buffer(0);
  });

  self.sock.connect({ host:server, port:port });
};

connection.prototype.authenticate = function(user, password){
  var self = this;

  var bufs = Buffers();
  bufs.push(Buffer(password));                    //server password
  bufs.push(zeroterm());
  bufs.push(Buffer(user?user:"node-openttd-admin"));  //admin name
  bufs.push(zeroterm());
  bufs.push(Buffer("0"));                         //version
  bufs.push(zeroterm());
  self.sendpacket(adminPackets.ADMIN_JOIN, bufs);
};

connection.prototype.sendpacket = function(t, p){
  var self = this;
  var buf = put().word16le(p ? p.length + 3 : 3).word8(t).buffer();
  self.sock.write(p ? Buffer.concat([buf, p.toBuffer()]) : buf);
};

connection.prototype.send_rcon = function(cmd){
  var self = this;
  var bufs = Buffers();
  bufs.push(Buffer(cmd));
  bufs.push(zeroterm());
  self.sendpacket(adminPackets.ADMIN_RCON, bufs);
};

connection.prototype.send_chat = function(action, desttype, id, msg){
  var self = this;
  var bufs = Buffers();
  bufs.push(put()
    .word8(action)
    .word8(desttype)
    .word32le(id)
    .buffer());
  bufs.push(Buffer(msg));
  bufs.push(zeroterm());
  self.sendpacket(adminPackets.ADMIN_CHAT, bufs);
};

connection.prototype.send_ping = function(int32){
  var self = this;
  var bufs = Buffers();
  bufs.push(put()
    .word32le(int32)
    .buffer());
  self.sendpacket(adminPackets.ADMIN_PING, bufs);
};

connection.prototype.error = function(errorMsg){
  var self = this;
  console.log("ERROR: ", errorMsg);
  self.emit('error', errorMsg);
};

connection.prototype.send_update_frequency = function(type, frequency){
  var self = this;
  var bufs = Buffers();
  bufs.push(put()
    .word16le(type)
    .word16le(frequency)
    .buffer());
  self.sendpacket(adminPackets.ADMIN_UPDATE_FREQUENCY, bufs);

};
connection.prototype.send_poll = function(type, id){
  var self = this;
  var bufs = Buffers();
  bufs.push(put()
    .word8(type)
    .word32le(id)
    .buffer());
  self.sendpacket(adminPackets.ADMIN_POLL, bufs);

}
connection.prototype.close = function(){
  var self = this;
  self.sendpacket(adminPackets.ADMIN_QUIT);
  this.sock.end();
  this.sock = false;
};

var zeroterm = (function(){
    var b = put().word8(0).buffer()
    return function() { return b }
}());

module.exports = {
  connection: connection,
  enums: tcp_enum,
}