'use strict'
const fs = require('fs')
const path = require('path')
const spawn = require('child_process').spawn
const pump = require('pump')
const split = require('split2')
const sym = require('perf-sym')
const debug = require('debug')('0x')
const traceStacksToTicks = require('../lib/trace-stacks-to-ticks')
const { promisify } = require('util')
const {
  getTargetFolder,
  tidy,
  pathTo
} = require('../lib/util')

module.exports = promisify(sun)

function sun (args, sudo, binary, cb) {
  const { status, outputDir, workingDir, name } = args
  
  var dtrace = pathTo('dtrace')
  var profile = require.resolve('perf-sym/profile_1ms.d')
  if (!dtrace) return void cb(Error('Unable to locate dtrace - make sure it\'s in your PATH'))
  if (!sudo) {
    status('Stacks are captured using DTrace, which requires sudo access\n')
    return spawn('sudo', ['true'])
      .on('exit', function () { sun(args, true, binary, cb) })
  }
  var node = !binary || binary === 'node' ? pathTo('node') : binary
  var kernelTracingDebug = args.kernelTracingDebug

  args = Object.assign([
    '--perf-basic-prof',
    '-r', path.join(__dirname, '..', 'lib', 'soft-exit')
  ].concat(args.argv), args)

  var proc = spawn(node, args, {
    stdio: 'inherit'
  }).on('exit', function (code) {
    if (code !== 0) {
      tidy(args)
      const err = Error('Target subprocess error, code: ' + code)
      err.code = code
      cb(err)
      return
    }
    analyze(true)
  })
  var folder
  var prof
  var profExited = false

  function start () {
    prof = spawn('sudo', [profile, '-p', proc.pid])

    if (kernelTracingDebug) { prof.stderr.pipe(process.stderr) }

    folder = getTargetFolder({outputDir, workingDir, name, pid: proc.pid})

    prof.on('exit', function (code) {
      profExited = true
    })

    pump(
      prof.stdout,
      fs.createWriteStream(path.join(folder, '.stacks.' + proc.pid + '.out')),
      function (err) {
        if (err) {
          cb(err)
          return
        }
        debug('dtrace out closed')
      })
    


    setTimeout(status, 100, 'Profiling')

    if (process.stdin.isPaused()) {
      process.stdin.resume()
      process.stdout.write('\u001b[?25l')
    }
  }

  start()

  process.once('SIGINT', analyze)

  function analyze (manual) {
    if (analyze.called) { return }
    analyze.called = true

    if (!prof) {
      debug('Profiling not begun')
      status('No stacks, profiling had not begun\n')
      tidy(args)
      cb(Error('Profiling not begun'))
      return 
    }

    if (!manual) {
      debug('Caught SIGINT, generating flamegraph')
      status('Caught SIGINT, generating flamegraph')
    }

    try { process.kill(proc.pid, 'SIGINT') } catch (e) {}
    try { process.kill(prof.pid, 'SIGINT') } catch (e) {}

    capture(10)
    function capture (attempts) {
      if (!profExited) {
        if (attempts) {
          if (attempts < 5) {
            // desperate, killing prof process
            try { process.kill(prof.pid, 'SIGKILL') } catch (e) {}
          }
          setTimeout(capture, 300, attempts - 1)
        } else {
          status('Unable to find map file!\n')
          debug('Unable to find map file after multiple attempts')
          tidy(args)
          cb(Error('0x: Unable to find map file'))
          return
        }
        return
      }
      var translate = sym({silent: true, pid: proc.pid})

      if (!translate) {
        debug('unable to find map file')
        if (attempts) {
          status('Unable to find map file - waiting 300ms and retrying\n')
          debug('retrying')
          setTimeout(capture, 300, attempts--)
          return
        }
        debug('Unable to find map file after multiple attempts')
        tidy(args)
        cb(Error('Unable to find map file'))
        return
      }
      pump(
        fs.createReadStream(folder + '/.stacks.' + proc.pid + '.out'),
        translate,
        fs.createWriteStream(folder + '/stacks.' + proc.pid + '.out'),
        (err) => {
          if (err) return void cb(err)
          cb(null, {
            ticks: traceStacksToTicks(folder + '/stacks.' + proc.pid + '.out'),
            pid: proc.pid, 
            folder: folder
          })
        }
      )

    }
  }
}
