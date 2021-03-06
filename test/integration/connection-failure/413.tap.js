'use strict'

var test         = require('tap').test
var nock         = require('nock')
var configurator = require('../../../lib/config.js')
var Agent        = require('../../../lib/agent.js')
var Transaction  = require('../../../lib/transaction')
var mockAWSInfo  = require('../../lib/nock/aws.js').mockAWSInfo


// XXX Remove this when deprecating Node v0.8.
if (!global.setImmediate) {
  var timers = require('timers')
  timers.setImmediate = global.setImmediate = function(fn) {
    global.setTimeout(fn, 0)
  }
}

nock.disableNetConnect()

test("harvesting with a mocked collector that returns 413 after connect", function (t) {
  var RUN_ID      = 1337
    , url         = 'https://collector.newrelic.com'
    , agent       = new Agent(configurator.initialize())
    , transaction = new Transaction(agent)


  function path(method, runID) {
    var fragment = '/agent_listener/invoke_raw_method?' +
      'marshal_format=json&protocol_version=14&' +
      'license_key=license%20key%20here&method=' + method

    if (runID) fragment += '&run_id=' + runID

    return fragment
  }

  // manually harvesting
  agent.config.no_immediate_harvest = true

  var redirect = nock(url).post(path('get_redirect_host'))
                   .reply(200, {return_value : "collector.newrelic.com"})
  var handshake = nock(url).post(path('connect'))
                    .reply(200, {return_value : {agent_run_id : RUN_ID}})
  var settings = nock(url).post(path('agent_settings', RUN_ID))
                   .reply(200, {return_value : []})

  var sendMetrics = nock(url).post(path('metric_data', RUN_ID)).reply(413)
  var sendEvents = nock(url).post(path('analytic_event_data', RUN_ID)).reply(413)
  var sendErrors  = nock(url).post(path('error_data', RUN_ID)).reply(413)
  var sendErrorEvents = nock(url).post(path('error_event_data', RUN_ID)).reply(413)
  var sendTrace   = nock(url).post(path('transaction_sample_data', RUN_ID)).reply(413)


  var sendShutdown = nock(url).post(path('shutdown', RUN_ID)).reply(200)

  // setup nock for AWS
  mockAWSInfo()

  agent.start(function cb_start(error, config) {
    t.notOk(error, 'got no error on connection')
    t.deepEqual(config, {agent_run_id : RUN_ID}, 'got configuration')
    t.ok(redirect.isDone(),    "requested redirect")
    t.ok(handshake.isDone(),   "got handshake")

    // need sample data to give the harvest cycle something to send
    agent.errors.add(transaction, new Error('test error'))

    transaction.end(function() {
      agent.traces.trace = transaction.trace

      agent.harvest(function cb_harvest(error) {
        t.notOk(error, "no error received on 413")
        t.ok(sendMetrics.isDone(), "initial sent metrics...")
        t.ok(sendEvents.isDone(), "...and then sent events...")
        t.ok(sendErrors.isDone(),  "...and then sent error data...")
        t.ok(sendTrace.isDone(),   "...and then sent trace, even though all returned 413")
        t.ok(sendErrorEvents.isDone(), "...and then sent error events")

        agent.stop(function cb_stop() {
          t.ok(settings.isDone(), "got agent_settings message")
          t.ok(sendShutdown.isDone(), "got shutdown message")
          t.end()
        })
      })
    })
  })
})

test("discarding metrics and errors after a 413", function (t) {
  t.plan(3)

  var RUN_ID      = 1338
    , url         = 'https://collector.newrelic.com'
    , agent       = new Agent(configurator.initialize())
    , transaction = new Transaction(agent)


  function path(method, runID) {
    var fragment = '/agent_listener/invoke_raw_method?' +
      'marshal_format=json&protocol_version=14&' +
      'license_key=license%20key%20here&method=' + method

    if (runID) fragment += '&run_id=' + runID

    return fragment
  }

  // manually harvesting
  agent.config.no_immediate_harvest = true

  nock(url).post(path('get_redirect_host'))
           .reply(200, {return_value : "collector.newrelic.com"})

  nock(url).post(path('connect'))
           .reply(200, {return_value : {agent_run_id : RUN_ID}})
  nock(url).post(path('agent_settings', RUN_ID))
           .reply(200, {return_value : []})

  nock(url).post(path('metric_data', RUN_ID)).reply(413)
  nock(url).post(path('error_data', RUN_ID)).reply(413)
  nock(url).post(path('transaction_sample_data', RUN_ID)).reply(413)

  nock(url).post(path('shutdown', RUN_ID)).reply(200)

  agent.start(function cb_start() {
    // need sample data to give the harvest cycle something to send
    agent.errors.add(transaction, new Error('test error'))
    agent.traces.trace = transaction.trace

    agent.harvest(function cb_harvest(error) {
      t.notOk(error, "shouldn't have gotten back error for 413")
      t.equal(agent.errors.errors.length, 0, "errors were discarded")
      t.deepEqual(agent.metrics.toJSON(), [], "metrics were discarded")

      agent.stop(function cb_stop() {})
    })
  })
})
