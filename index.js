require('shelljs/global');
require('dotenv').config();

var fs = require('fs');
var jsdom = require('jsdom');
var async = require('async');
var anticaptcha = require('anti-captcha');
var service = anticaptcha('http://anti-captcha.com', process.env.ANTI_CAPTCHA_KEY);
require('lambda-git')();

var userAgent = 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko';
var username = env.RVIS_USERNAME;
var password = env.RVIS_PASSWORD;
var baseUrl = 'http://rvis-manage.mohw.gov.tw';
var loginUrl = baseUrl + '/login.do';
var downloadUrl = baseUrl + '/jsp/sg/sg2/sg25020_rpt.jsp';
var captchaUrl = baseUrl + '/ImageServlet';
var htmlFilename = '/tmp/aid.html';
var csvFilename = '/tmp/aid.csv';
var RE_COOKIE = /Set-Cookie: (.+?)=(.+?);/;
var repo = env.AID_GH_REF;
var token = env.AID_GH_TOKEN;

module.exports = function(cb) {
  var finish = function(err) {
    if (err) {
      cb(err);
    }
    else {
      const response = {
        statusCode: 200,
        body: JSON.stringify({
          message: 'successful'
        }),
      };
      console.log('upload to github');
      var email = exec('git config user.email').output;
      if (!email) {
        console.log('setup email and username');
        exec('git config user.email aid@g0v.tw');
        exec('git config user.name "aid-sync project"');
      }

      console.log('switch to /tmp and remove "out" directory');
      cd('/tmp');
      rm('-rf', 'out');

      console.log('cloning...');
      exec('git clone "https://' + token +
          '@' + repo + '" --depth 1 -b gh-pages out');
      console.log('done, copy csv file');
      cp('-f', csvFilename, 'out');
      cd('out');
      exec('git add .');
      exec('git commit -m "Automatic commit: ' + Date() + '"');
      console.log('pushing back to github');
      exec('git push "https://' + token +
          '@' + repo + '" gh-pages', {silent: true});
      cb(null, response);
    }
  }

  var cookieJar = jsdom.createCookieJar();
  async.waterfall([
    function(done) {
      console.log('opening first page');
      jsdom.env({
        url: loginUrl,
        cookieJar,
        done: function(err, window) {
          done(null, window.document.cookie);
        }
      });
    },
    function(cookie, done) {
      console.log('download captcha');
      var downloadCaptchaCommand = `curl '${captchaUrl}' -H 'User-Agent: ${userAgent}' -H 'Cookie: ${cookie}' -o /tmp/captcha.jpg`;
      exec(downloadCaptchaCommand);
      done(null, cookie);
    },
    function(cookie, done) {
      console.log('decode...');
      var captcha = fs.readFileSync('/tmp/captcha.jpg');
      var base64 = new Buffer(captcha).toString('base64');
      service.uploadCaptcha(base64, {phrase: true})
      .then(captcha => service.getText(captcha))
      .then(captcha => {
        console.log('captcha.text', captcha.text);
        done(null, captcha.text, cookie);
      });
    },
    function(captcha, cookie, done) {
      console.log('login');
      var loginCommand = [
        'curl',
        '--user-agent "' + userAgent + '" ',
        `-H 'Cookie: ${cookie}'`,
        `--data "yn_cert=N&user_id=${process.env.ENCODED_RVIS_USERNAME}&user_pwd=${process.env.ENCODED_RVIS_PASSWORD}&checkcode=${captcha}"`,
        '--connect-timeout 5 --max-time 5 --retry 15',
        '-i',
        loginUrl
      ].join(' ');

      exec(loginCommand, {silent: true});
      done(null, cookie);
    },

    function(cookie, done) {
      echo('downloading html');
      var downloadCommand = [
        'curl',
        '-H \'Content-Type: application/x-www-form-urlencoded\'',
        '-H "Cookie: ' + cookie + '"',
        '--data \'prog_id=SG25020&qcityno=6300000000\'',
        '--connect-timeout 5 --max-time 30 --retry 15 -v',
        '-o ' + htmlFilename,
        downloadUrl
      ].join(' ');

      exec(downloadCommand);
      var html = cat(htmlFilename);
      done(null, html);
    },

    function(html, done) {
      console.log('parsing csv');
      jsdom.env(
        html,
        ['http://code.jquery.com/jquery.js'],
        function (err, window) {
          echo('parsing to csv file');
          var $ = window.$;

          var csv = [];
          var rows = $('tr').toArray();
          rows.forEach(function(row, i) {
            if (i === 0) return;

            var line = $(row).find('td').toArray().map(function(val) {
              var text = val.textContent.replace(/(?:\r\n|\r|\n)/g, ' ');
              return '"' + text + '"';
            }).join(',');
            csv.push(line);
          });
          csv.join('\n').to(csvFilename);
          done();
        }
      );
    }
  ], finish);
}
