"use strict";

var express         = require('express');
var path            = require('path');
var favicon         = require('serve-favicon');
var morgan          = require('morgan');
var cookieParser    = require('cookie-parser');
var bodyParser      = require('body-parser');
var requestp        = require("request-promise");
var log4js          = require('log4js-config');
var logger          = log4js.get('[app]');
const PubSub        = require('@google-cloud/pubsub');
var index           = require('./routes/index');
const config        = require('./config/config');
const dialogflow    = require('dialogflow');

const FB_GRAPH_API_VERSION = "2.11";

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', index);


// Init google DialogFlow session
const sessionClient = new dialogflow.SessionsClient({
  projectId: config.DIALOG_FLOW_V2_GOOGLE_CLOUD_PROJECT_ID,
  keyFilename: path.join(__dirname, 'config', config.DIALOG_FLOW_V2_SERVICE_ACCOUNT_FILE)
});

//Init google cloud pub/sub infrastructure
const pubsub = PubSub({
  projectId: config.GOOGLE_CLOUD_PROJECT_ID,
  keyFilename: path.join(__dirname, 'config', config.GOOGLE_CLOUD_SERVICE_ACCOUNT_FILE)
});

const subscription = pubsub.subscription(config.GOOGLE_CLOUD_SUBSCRIPTION);


app.get("/remove-listener", (req,res,next) => {
  logger.info('removing listener...');
  subscription.removeListener(`message`, messageHandler);
  subscription.removeListener(`error`, errorHandler);
  logger.info('listener removed!');  
  res.status(200).send("listener removed!");
});

app.get("/restore-listener", (req,res,next) => {
  logger.info('restoring listener...');
  subscription.on('message', messageHandler);
  subscription.on('error', errorHandler);
  logger.info('listener restored!');  
  res.status(200).send("listener restored!");
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});


async function sendTextMessageSync(senderId, requestJSON){
  let promise = sendTextMessage(senderId, requestJSON);
  let result = await promise;
  logger.debug("sendTextMessageSync finished "+result);
}

const sendTextMessage = (senderId, requestJSON) => {
  return requestp({
      uri: "https://graph.facebook.com/v" + FB_GRAPH_API_VERSION + "/me/messages",
      qs: { access_token: config.FACEBOOK_PAGE_ACCESS_TOKEN },
      "json": true,
      method: 'POST',
      json: requestJSON
  });
}


const messageHandler = function(msg) {
  
  let event = JSON.parse(msg.data.toString());

  logger.info('Message: ' + JSON.stringify(event));

  const senderId = event.sender.id;
  const message = event.message.text;

  
  //DialogFlow V2 API
  // The path to identify the agent that owns the created intent.
  let sessionPath = sessionClient.sessionPath(config.DIALOG_FLOW_V2_GOOGLE_CLOUD_PROJECT_ID, "mySession1");

  let request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: message,
        languageCode: "en",
      }
    }  
  }  
    
/**/
  sessionClient.detectIntent(request)
  .then(responses => {

    //in first iteration process default text messages only!
    responses.forEach(response => {
      response.queryResult.fulfillmentMessages.forEach(fulfillmentMessage => {

        let requestJSON = { recipient: { id: senderId }, message: {} };//initial facebook object

        switch(fulfillmentMessage.message){
         
          case "quickReplies":
            break;
          case "text":
               
              fulfillmentMessage.text.text.forEach(textItem => {
                requestJSON.message.text = textItem;
              });

              logger.debug("Sending simple message "+JSON.stringify(requestJSON));
              sendTextMessageSync(senderId, requestJSON)
              .then(parsedBody => {
                logger.info("sendTextMessage OK");
              })
              .catch(err => {
                logger.error("sendTextMessage KO " + JSON.stringify(err)); 
              });  
              break;

        }//end switch

      });//for each fullfillmentMessage
    });//for each response

    //in second iteration process rich messages only
    responses.forEach(response => {
      response.queryResult.fulfillmentMessages.forEach(fulfillmentMessage => {


        let requestJSON = { recipient: { id: senderId }, message: {} };//initial facebook object

        switch(fulfillmentMessage.message){
         
          case "quickReplies":

              requestJSON.message.text = fulfillmentMessage.quickReplies.title;
              requestJSON.message.quick_replies = [];

              fulfillmentMessage.quickReplies.quickReplies.forEach(quickReply => {
                requestJSON.message.quick_replies.push({
                  "content_type": "text",
                  "title": quickReply,
                  "payload": quickReply
                });
              });

              logger.debug("Sending rich json "+JSON.stringify(requestJSON));
              sendTextMessageSync(senderId, requestJSON)
              .then(parsedBody => {
                logger.info("sendTextMessage -rich- OK");
              })
              .catch(err => {
                logger.error("sendTextMessage -rich- KO " + JSON.stringify(err)); 
              });  

              break;
          
          case "text":
              break;

        }//end switch

      });//for each fullfillmentMessage
    });//for each response    
    
  })
  .catch(err => {
    logger.error("sessionClient.detectIntent error " + JSON.stringify(err));
  });
  

  msg.ack();//confirm message back to google
};

const errorHandler = function(error) {
  logger.error('GCloud subscription error ' + JSON.stringify(error));
};

subscription.on('message', messageHandler);
subscription.on('error', errorHandler);

logger.info("GCloud subscription listener for facebook events activated!");


// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;