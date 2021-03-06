var sio = require("socket.io");
var parseCookie = require("cookie").parse;
var Logger = require("../logger");
var db = require("../database");
var User = require("../user");
var Server = require("../server");
var Config = require("../config");
var $util = require("../utilities");

var CONNECT_RATE = {
    burst: 5,
    sustained: 0.1
};

var ipThrottle = {};
// Keep track of number of connections per IP
var ipCount = {};

/**
 * Called before an incoming socket.io connection is accepted.
 */
function handleAuth(data, accept) {
    data.user = false;
    if (data.headers.cookie) {
        data.cookie = parseCookie(data.headers.cookie);
        var auth = data.cookie.auth;
        db.users.verifyAuth(auth, function (err, user) {
            if (!err) {
                data.user = {
                    name: user.name,
                    global_rank: user.global_rank
                };
            }
            accept(null, true);
        });
    } else {
        accept(null, true);
    }
}

/**
 * Called after a connection is accepted
 */
function handleConnection(sock) {
    sock._ip = sock.handshake.address.address;
    var ip = sock._ip;
    var srv = Server.getServer();
    if (srv.torblocker && srv.torblocker.shouldBlockIP(ip)) {
        sock.emit("kick", {
            reason: "This server does not allow connections from Tor.  "+
                    "Please log in with your regular internet connection."
        });
        Logger.syslog.log("Blocked Tor IP: " + ip);
        sock.disconnect(true);
        return;
    }

    if (!(ip in ipThrottle)) {
        ipThrottle[ip] = $util.newRateLimiter();
    }

    if (ipThrottle[ip].throttle(CONNECT_RATE)) {
        Logger.syslog.log("WARN: IP throttled: " + ip);
        sock.emit("kick", {
            reason: "Your IP address is connecting too quickly.  Please "+
                    "wait 10 seconds before joining again."
        });
        return;
    }

    // Check for global ban on the IP
    db.isGlobalIPBanned(ip, function (err, banned) {
        if (banned) {
            Logger.syslog.log("Disconnecting " + ip + " - global banned");
            sock.emit("kick", { reason: "Your IP is globally banned." });
            sock.disconnect(true);
        }
    });

    sock.on("disconnect", function () {
        ipCount[ip]--;
        if (ipCount[ip] === 0) {
            /* Clear out unnecessary counters to save memory */
            delete ipCount[ip];
        }
    });

    if (!(ip in ipCount)) {
        ipCount[ip] = 0;
    }

    ipCount[ip]++;
    if (ipCount[ip] > Config.get("io.ip-connection-limit")) {
        sock.emit("kick", {
            reason: "Too many connections from your IP address"
        });
        sock.disconnect(true);
        return;
    }

    Logger.syslog.log("Accepted socket from " + ip);
    var user = new User(sock);
    if (sock.handshake && sock.handshake.user) {
        user.name = sock.handshake.user.name;
        user.global_rank = sock.handshake.user.global_rank;
        user.loggedIn = true;
        user.emit("login");
        user.socket.emit("login", {
            success: true,
            name: user.name,
            guest: false
        });
        user.socket.emit("rank", user.global_rank);
        Logger.syslog.log(ip + " logged in as " + user.name);
    } else {
        user.socket.emit("rank", -1);
    }
}

module.exports = {
    init: function (srv) {
        Config.get("listen").forEach(function (bind) {
            if (!bind.io) {
                return;
            }
            var id = bind.ip + ":" + bind.port;
            if (id in srv.ioServers) {
                Logger.syslog.log("[WARN] Ignoring duplicate listen address " + id);
                return;
            }

            var io = null;
            if (id in srv.servers) {
                io = srv.ioServers[id] = sio.listen(srv.servers[id]);
            } else {
                io = srv.ioServers[id] = sio.listen(bind.port, bind.ip);
            }
                
            if (io) {
                io.set("log level", 1);
                io.set("authorization", handleAuth);
                io.on("connection", handleConnection);
            }
        });
    }
};

/* Clean out old rate limiters */
setInterval(function () {
    for (var ip in ipThrottle) {
        if (ipThrottle[ip].lastTime < Date.now() - 60 * 1000) {
            var obj = ipThrottle[ip];
            /* Not strictly necessary, but seems to help the GC out a bit */
            for (var key in obj) {
                delete obj[key];
            }
            delete ipThrottle[ip];
        }
    }

    if (Config.get("aggressive-gc") && global && global.gc) {
        global.gc();
    }
}, 5 * 60 * 1000);
