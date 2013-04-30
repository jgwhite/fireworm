var fs = require('fs')
var path = require('path')
var EventEmitter = require('events').EventEmitter.prototype
var matchesStart = require('./matches_start')
var minimatch = require('minimatch')
var Set = require('set')
var log = require('winston')

log.remove(log.transports.Console)
log.add(log.transports.File, {filename: 'fireworm.log'})

/* 

A file info keeper keeps the stat objects and watcher object for a collection of files (or directories).

`stats` and `watchers` are a dictionary key'ed by ino. `inos` is a dictionary key'ed by file path.

*/
function fileinfoKeeper(){
    var fk = Object.create(EventEmitter)

    fk.init = function(){
        fk.stats = {}
        fk.inos = {}
        fk.watchers = {}
    }
    fk.init()

    fk.save = function(path, stat){
        fk.inos[path] = stat.ino
        fk.stats[stat.ino] = stat
    }

    fk.remove = function(path){
        var ino = fk.inos[path]
        delete fk.stats[ino]
        delete fk.inos[path]
        fk.unwatch(ino)
    }

    fk.watch = function(path, onAccessed){
        var ino = fk.inos[path]
        if (fk.watchers[ino]) return
        try{
            fk.watchers[ino] = {
                path: path
                , watcher: fs.watch(path, function(evt){
                    onAccessed(evt, path)
                })
            }
        }catch(e){
            if (e.message.match(/EMFILE/)){
                fk.emit('EMFILE', e.message)
            }else{
                fk.emit('fw-error', e.message)
            }
        }
    }

    fk.unwatch = function(ino){
        var info = fk.watchers[ino]
        if (info){
            info.watcher.close()
            delete fk.watchers[ino]
        }
    }

    fk.clear = function(){
        for (var ino in fk.watchers){
            fk.watchers[ino].watcher.close()
        }
        fk.init()
    }

    fk.get = function(path){
        return fk.stats[fk.inos[path]]
    }

    fk.knownPaths = function(){
        return Object.keys(fk.inos)
    }

    return fk
}


/*

fireworm is a file watcher - the sole export of this module.

*/
module.exports = fireworm
function fireworm(){

    var fw = Object.create(EventEmitter)

    fw.init = function(){
        fw.taskCount = 0
        fw.dirs = fileinfoKeeper()
        fw.files = fileinfoKeeper()
        fw.patterns = new Set
        fw.trackedDirs = new Set
    }
    fw.init()

    fw.pushTask = function(){
        fw.taskCount++
    }

    fw.popTask = function(){
        fw.taskCount--
        if (fw.taskCount === 0){
            process.nextTick(function(){
                log.info('emit ready')
                fw.emit('ready')
            })
        }
    }

    fw.printInfo = function(){
        console.log('dirs')
        console.log(fw.dirs)
        console.log('files')
        console.log(fw.files)
    }

    fw.clear = function(){
        fw.files.clear()
        fw.dirs.clear()
        fw.init()
    }

    fw.crawl = function(thing, depth, options){
        log.info('crawl ' + thing)
        options = options || {}
        if (fw.hasEMFILE) return
        if (options.maxDepth && depth > options.maxDepth) return
        if (!fw.needToWatchDir(thing)){
            log.info('crawl skipping ' + thing)
            return
        }
        fw.pushTask()
        log.info('crawl here ' + thing)
        fs.stat(thing, function(err, stat){
            try{
                log.info('crawl stat')
                if (err){
                    log.info('stat err ' + err)
                    fw.popTask()
                    return
                }
                if (stat.isDirectory()){
                    log.info('crawl is dir')
                    fw.crawlDir(thing, stat, depth, options, function(){
                        fw.popTask()
                    })
                }else if (stat.isFile()){
                    fw.crawlFile(thing, stat, options)
                    fw.popTask()
                }
            }catch(e){
                log.info(e.message)
                log.info(e.stack)
            }
        })
    }

    fw.crawlDir = function(dir, stat, depth, options, callback){
        log.info('crawlDir ' + dir)
        var ino = fw.dirs.get(dir)
        if (ino !== stat.ino){
            fw.dirs.remove(dir)
        }
        fw.dirs.save(dir, stat)
        fw.dirs.watch(dir, fw.onDirAccessed)
        fs.readdir(dir, function(err, files){
            if (err) return
            files.forEach(function(file){
                fw.crawl(path.join(dir, file), depth + 1, options)
            })
            if (callback) callback()
        })
    }

    fw.crawlFile = function(file, stat, options){
        if (file.match(/tests.js$/)){
            log.info('fireworm: crawl file ' + file)
        }
        var isNewFile = !fw.files.get(file)
        fw.files.save(file, stat)
        log.info('watch file ' + file)
        fw.files.watch(file, fw.onFileAccessed)
        if (options.notifyNewFiles && isNewFile){
            fw.emit('change', file)
        }
    }

    fw.needToWatchDir = function(dir){
        dir = path.resolve(dir)
        return fw.patterns.get().reduce(function(curr, pattern){
            pattern = path.resolve(pattern)
            return curr || matchesStart(dir, pattern)
        }, false)
    }

    fw.needToWatchFile = function(file){
        file = path.resolve(file)
        return fw.patterns.get().reduce(function(curr, pattern){
            pattern = path.resolve(pattern)
            return curr || minimatch(file, pattern)
        }, false)
    }

    fw.isTracked = function(dir){
        var fullPath = path.resolve(dir) + '/'
        return fw.trackedDirs.get().reduce(function(tracked, watchedDir){
            var watchedFullPath = path.resolve(watchedDir) + '/'
            var contains = fullPath.substring(0, watchedFullPath.length) === watchedFullPath
            return tracked || contains
        }, false)
    }

    fw.trackDir = function(dir){
        if (fw.isTracked(dir)) return
        fw.trackedDirs.add(dir)
        fw.pushTask()
        process.nextTick(function(){
            fw.crawl(dir, 0)
            fw.popTask()
        })
    }

    fw.add = function(){
        if (arguments[0] && arguments[0].match(/tests.js$/)){
            log.info('fireworm: add ' + Array.prototype.slice.apply(arguments).join(' '))
        }
        for (var i = 0; i < arguments.length; i++){
            fw.patterns.add(arguments[i])
        }
        fw.trackDir('.')
    }

    fw.ifFileOutOfDate = function(filename, callback){
        var oldStat = fw.files.get(filename)
        fs.stat(filename, function(err, stat){
            if (err){
                fw.files.remove(filename)
                if (oldStat) callback(true)
            }else{
                var then = oldStat.mtime.getTime()
                var now = stat.mtime.getTime()
                if (then < now){
                    fw.files.save(filename, stat)
                    callback(true)
                }else{
                    callback(false)
                }
            }
        })
    }

    fw.onFileAccessed = function(evt, filename){
        fw.ifFileOutOfDate(filename, function(yes){
            if (evt === 'rename'){
                // it has been deleted, so re-crawl parent directory
                fw.crawl(path.dirname(filename), 0)
            }
            if (yes){
                fw.emit('change', filename)  
            }
        })
    }

    fw.onDirAccessed = function(evt, dir){
        process.nextTick(function(){
            fw.crawl(dir, 0, {notifyNewFiles: true})
        })
    }

    fw.watchedDirs = function(){
        return fw.dirs.knownPaths()
    }

    fw.watchedFiles = function(){
        return fw.files.knownPaths()
    }

    fw.knownDirs = function(){
        return fw.dirs.knownPaths()
    }

    fw.knownFiles = function(){
        return fw.files.knownPaths()
    }

    fw.onEMFILE = function(){
        fw.hasEMFILE = true
        fw.emit('EMFILE')
        fw.clear()
    }
    fw.dirs.on('EMFILE', fw.onEMFILE)
    fw.files.on('EMFILE', fw.onEMFILE)

    return fw
}
