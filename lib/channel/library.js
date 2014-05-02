var ChannelModule = require("./module");
var Flags = require("../flags");
var util = require("../utilities");
var InfoGetter = require("../get-info");
var db = require("../database");

const TYPE_UNCACHE = {
    id: "string"
};

const TYPE_SEARCH_MEDIA = {
    source: "string,optional",
    query: "string" }; 
function LibraryModule(channel) {
    ChannelModule.apply(this, arguments);
}

LibraryModule.prototype = Object.create(ChannelModule.prototype);

LibraryModule.prototype.onUserPostJoin = function (user) {
    user.socket.typecheckedOn("uncache", TYPE_UNCACHE, this.handleUncache.bind(this, user));
    user.socket.typecheckedOn("searchMedia", TYPE_SEARCH_MEDIA, this.handleSearchMedia.bind(this, user));
};

LibraryModule.prototype.cacheMedia = function (media) {
    /* Google Drive videos should not be cached due to the expiration */
    if (media.type === "gd") {
        return false;
    }

    if (this.channel.is(Flags.C_REGISTERED)) {
        db.channels.addToLibrary(this.channel.name, media);
    }
};

LibraryModule.prototype.getItem = function (id, cb) {
    db.channels.getLibraryItem(this.channel.name, id, cb);
};

LibraryModule.prototype.handleUncache = function (user, data) {
    if (!this.channel.is(Flags.C_REGISTERED)) {
        return;
    }

    if (!this.channel.modules.permissions.canUncache(user)) {
        return;
    }

    var chan = this.channel;
    db.channels.deleteFromLibrary(chan.name, data.id, function (err, res) {
        if (chan.dead || err) {
            return;
        }

        chan.logger.log("[library] " + user.getName() + " deleted " + data.id +
                        "from the library");
    });
};

LibraryModule.prototype.handleSearchMedia = function (user, data) {
    var query = data.query.substring(0, 100);
    var searchYT = function () {
        InfoGetter.Getters.ytSearch(query.split(" "), function (e, vids) {
            if (!e) {
                user.socket.emit("searchResults", {
                    source: "yt",
                    results: vids
                });
            }
        });
    };

    if (data.source === "yt") {
        searchYT();
    } else {
        db.channels.searchLibrary(this.channel.name, query, function (err, res) {
            if (err) {
                res = [];
            }

            if (res.length === 0) {
                return searchYT();
            }

            res.sort(function (a, b) {
                var x = a.title.toLowerCase();
                var y = b.title.toLowerCase();
                return (x === y) ? 0 : (x < y ? -1 : 1);
            });

            res.forEach(function (r) {
                r.duration = util.formatTime(r.seconds);
            });

            user.socket.emit("searchResults", {
                source: "library",
                results: res
            });
        });
    }
};

module.exports = LibraryModule;