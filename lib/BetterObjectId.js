/*
*
* Copyright (c) 2011 Justin Dearing (zippy1981@gmail.com)
* Dual licensed under the MIT (http://www.opensource.org/licenses/mit-license.php)
* and GPL (http://www.opensource.org/licenses/gpl-license.php) version 2 licenses.
* This software is not distributed under version 3 or later of the GPL.
*
* Version 1.0.1-dev
*
*/

/**
 * Javascript class that mimics how WCF serializes a object of type MongoDB.Bson.ObjectId
 * and converts between that format and the standard 24 character representation.
*/
var ObjectId = (function () {
    var increment = 0;
    var pid = Math.floor(Math.random() * (32767));
    var machine = Math.floor(Math.random() * (16777216));

    if (typeof (localStorage) != 'undefined') {
        if(localStorage != null) {
            var mongoMachineId = parseInt(localStorage['mongoMachineId']);
            if (mongoMachineId >= 0 && mongoMachineId <= 16777215) {
                machine = Math.floor(localStorage['mongoMachineId']);
            }
            // Just always stick the value in.
            localStorage['mongoMachineId'] = machine;
            if (typeof (document) != 'undefined') {
                document.cookie = 'mongoMachineId=' + machine + ';expires=Tue, 19 Jan 2038 05:00:00 GMT';
            }
        }
    }
    else {
        if (typeof (document) != 'undefined') {
            var cookieList = document.cookie.split('; ');
            for (var i in cookieList) {
                var cookie = cookieList[i].split('=');
                if (cookie[0] == 'mongoMachineId' && cookie[1] >= 0 && cookie[1] <= 16777215) {
                    machine = cookie[1];
                    break;
                }
            }
            document.cookie = 'mongoMachineId=' + machine + ';expires=Tue, 19 Jan 2038 05:00:00 GMT';
        }
    }

    function ObjId() {
        if (!(this instanceof ObjectId)) {
            return new ObjectId(arguments[0], arguments[1], arguments[2], arguments[3]).toString();
        }

        if (typeof (arguments[0]) == 'object') {
            this.timestamp = arguments[0].timestamp;
            this.machine = arguments[0].machine;
            this.pid = arguments[0].pid;
            this.increment = arguments[0].increment;
        }
        else if (typeof (arguments[0]) == 'string' && arguments[0].length == 24) {
            this.timestamp = Number('0x' + arguments[0].substr(0, 8)),
            this.machine = Number('0x' + arguments[0].substr(8, 6)),
            this.pid = Number('0x' + arguments[0].substr(14, 4)),
            this.increment = Number('0x' + arguments[0].substr(18, 6))
        }
        else if (arguments.length == 4 && arguments[0] != null) {
            this.timestamp = arguments[0];
            this.machine = arguments[1];
            this.pid = arguments[2];
            this.increment = arguments[3];
        }
        else {
            this.timestamp = Math.floor(new Date().valueOf() / 1000);
            this.machine = machine;
            this.pid = pid;
            this.increment = increment++;
            if (increment > 0xffffff) {
                increment = 0;
            }
        }
    };
    return ObjId;
})();

ObjectId.prototype.getDate = function () {
    return new Date(this.timestamp * 1000);
};

ObjectId.prototype.toArray = function () {
    var strOid = this.toString();
    var array = [];
    var i;
    for(i = 0; i < 12; i++) {
        array[i] = parseInt(strOid.slice(i*2, i*2+2), 16);
    }
    return array;
};

/**
* Turns a WCF representation of a BSON ObjectId into a 24 character string representation.
*/
ObjectId.prototype.toString = function () {
    var timestamp = this.timestamp.toString(16);
    var machine = this.machine.toString(16);
    var pid = this.pid.toString(16);
    var increment = this.increment.toString(16);
    return '00000000'.substr(0, 8 - timestamp.length) + timestamp +
           '000000'.substr(0, 6 - machine.length) + machine +
           '0000'.substr(0, 4 - pid.length) + pid +
           '000000'.substr(0, 6 - increment.length) + increment;
};

//Adapted Meteor functions

ObjectId.prototype.equals = function(other){
    var self = this;
    //TODO: do instanceof comparison on classname
    return self.valueOf() === other.valueOf() && other instanceof ObjectId;
}

ObjectId.prototype.clone = function(){
    var self = this;
    //TODO: confirm classname
    return new ObjectId(self);
}

ObjectId.prototype.typeName = function(){
    return "oid"
}

ObjectId.prototype.getTimestamp = function(){
    var self = this;
    return self.timeStamp;
}

ObjectId.prototype.valueOf =
ObjectId.prototype.toJSONValue =
ObjectId.prototype.toHexString =  function(){
    var self = this;
    return self.toString();
}

ObjectId.prototype.selectorIsId = function(selector){
    //TODO: confirm classname
    return (typeof selector === "string") ||
    (typeof selector === "number") ||
    selector instanceof ObjectId;
}

ObjectId.prototype.selectorIsIdPerhapsAsObject = function(selector){
    var self = this;
    return self._selectorIsId(selector) ||
    (selector && typeof selector === "object" &&
     selector._id && self._selectorIsId(selector._id) &&
     _.size(selector) === 1);
}

ObjectId.prototype.idsMatchedBySelector = function(selector){
    var self = this;
    // Is the selector just an ID?
    if (self._selectorIsId(selector))
    return [selector];
    if (!selector)
    return null;

    // Do we have an _id clause?
    if (_.has(selector, '_id')) {
    // Is the _id clause just an ID?
    if (self._selectorIsId(selector._id))
      return [selector._id];
    // Is the _id clause {_id: {$in: ["x", "y", "z"]}}?
    if (selector._id && selector._id.$in
        && _.isArray(selector._id.$in)
        && !_.isEmpty(selector._id.$in)
        && _.all(selector._id.$in, self._selectorIsId)) {
      return selector._id.$in;
    }
    return null;
    }

    // If this is a top-level $and, and any of the clauses constrain their
    // documents, then the whole selector is constrained by any one clause's
    // constraint. (Well, by their intersection, but that seems unlikely.)
    if (selector.$and && _.isArray(selector.$and)) {
    for (var i = 0; i < selector.$and.length; ++i) {
      var subIds = self._idsMatchedBySelector(selector.$and[i]);
      if (subIds)
        return subIds;
    }
    }

    return null;
}

module['exports'] = ObjectId;
