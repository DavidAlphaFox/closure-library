/**
 * @license
 * Copyright The Closure Library Authors.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview the XHR stream reader implements a low-level stream
 * reader for handling a streamed XHR response body. The reader takes a
 * StreamParser which may support JSON or any other formats as confirmed by
 * the Content-Type of the response. The reader may be used as polyfill for
 * different streams APIs such as Node streams or whatwg streams (Fetch).
 *
 * The first version of this implementation only covers functions necessary
 * to support NodeReadableStream. In a later version, this reader will also
 * be adapted to whatwg streams.
 *
 * For IE, only IE-10 and above are supported.
 *
 * TODO(user): xhr polling, stream timeout, CORS and preflight optimization.
 */

goog.module('goog.net.streams.xhrStreamReader');

goog.module.declareLegacyNamespace();

const Base64PbStreamParser = goog.require('goog.net.streams.Base64PbStreamParser');
const ErrorCode = goog.require('goog.net.ErrorCode');
const Event = goog.requireType('goog.events.Event');
const EventHandler = goog.require('goog.events.EventHandler');
const EventType = goog.require('goog.net.EventType');
const HttpStatus = goog.require('goog.net.HttpStatus');
const JsonStreamParser = goog.require('goog.net.streams.JsonStreamParser');
const PbJsonStreamParser = goog.require('goog.net.streams.PbJsonStreamParser');
const PbStreamParser = goog.require('goog.net.streams.PbStreamParser');
const StreamParser = goog.requireType('goog.net.streams.StreamParser');
const XhrIo = goog.require('goog.net.XhrIo');
const XmlHttp = goog.require('goog.net.XmlHttp');
const googLog = goog.require('goog.log');
const googString = goog.require('goog.string');
const googUserAgent = goog.require('goog.userAgent');

/**
 * The XhrStreamReader class.
 *
 * The caller must check isStreamingSupported() first.
 * @struct
 * @final
 * @package
 */
class XhrStreamReader {
  /**
   * @param {!XhrIo} xhr The XhrIo object with its response body to
   * be handled by NodeReadableStream.
   */
  constructor(xhr) {
    'use strict';
    /**
     * @const
     * @private {?googLog.Logger} the logger.
     */
    this.logger_ = googLog.getLogger('XhrStreamReader');

    /**
     * The xhr object passed by the application.
     * @private {?XhrIo} the XHR object for the stream.
     */
    this.xhr_ = xhr;

    /**
     * To be initialized with the correct content-type.
     *
     * @private {?StreamParser} the parser for the stream.
     */
    this.parser_ = null;

    /**
     * The position of where the next unprocessed data starts in the XHR
     * response text.
     * @private {number}
     */
    this.pos_ = 0;

    /**
     * The status (error detail) of the current stream.
     * @private {!XhrStreamReaderStatus}
     */
    this.status_ = XhrStreamReaderStatus.INIT;

    /**
     * The handler for any status change event.
     *
     * @private {?function()} The call back to handle the XHR status change.
     */
    this.statusHandler_ = null;

    /**
     * The handler for new response data.
     *
     * @private {?function(!Array<!Object>)} The call back to handle new
     * response data, parsed as an array of atomic messages.
     */
    this.dataHandler_ = null;

    /**
     * An object to keep track of event listeners.
     *
     * @private {!EventHandler<!XhrStreamReader>}
     */
    this.eventHandler_ = new EventHandler(this);

    // register the XHR event handler
    this.eventHandler_.listen(
        this.xhr_, EventType.READY_STATE_CHANGE, this.readyStateChangeHandler_);
  }

  /**
   * Returns whether response streaming is supported on this browser.
   *
   * @return {boolean} false if response streaming is not supported.
   */
  static isStreamingSupported() {
    'use strict';
    if (googUserAgent.IE && !googUserAgent.isDocumentModeOrHigher(10)) {
      // No active-x due to security issues.
      return false;
    }

    if (googUserAgent.WEBKIT && !googUserAgent.isVersionOrHigher('420+')) {
      // Safari 3+
      // Older versions of Safari always receive null response in INTERACTIVE.
      return false;
    }

    if (googUserAgent.OPERA && !googUserAgent.WEBKIT) {
      // Old Opera fires readyState == INTERACTIVE once.
      // TODO(user): polling the buffer and check the exact Opera version
      return false;
    }

    return true;
  }


  /**
   * Called from readyStateChangeHandler_.
   *
   * @private
   */
  onReadyStateChanged_() {
    'use strict';
    const readyState = this.xhr_.getReadyState();
    const errorCode = this.xhr_.getLastErrorCode();
    const statusCode = this.xhr_.getStatus();
    const responseText = this.xhr_.getResponseText();

    // we get partial results in browsers that support ready state interactive.
    // We also make sure that getResponseText is not null in interactive mode
    // before we continue.
    if (readyState < XmlHttp.ReadyState.INTERACTIVE ||
        readyState == XmlHttp.ReadyState.INTERACTIVE && !responseText) {
      return;
    }

    // TODO(user): white-list other 2xx responses with application payload
    const successful =
        (statusCode == HttpStatus.OK ||
         statusCode == HttpStatus.PARTIAL_CONTENT);

    if (readyState == XmlHttp.ReadyState.COMPLETE) {
      if (errorCode == ErrorCode.TIMEOUT) {
        this.updateStatus_(XhrStreamReaderStatus.TIMEOUT);
      } else if (errorCode == ErrorCode.ABORT) {
        this.updateStatus_(XhrStreamReaderStatus.CANCELLED);
      } else if (!successful) {
        this.updateStatus_(XhrStreamReaderStatus.XHR_ERROR);
      }
    }

    if (successful && !responseText) {
      googLog.warning(
          this.logger_,
          'No response text for xhr ' + this.xhr_.getLastUri() + ' status ' +
              statusCode);
    }

    if (!this.parser_) {
      this.parser_ = this.getParserByResponseHeader_();
      if (this.parser_ == null) {
        this.updateStatus_(XhrStreamReaderStatus.BAD_DATA);
      }
    }

    if (this.status_ > XhrStreamReaderStatus.SUCCESS) {
      this.clear_();
      return;
    }

    // Parses and delivers any new data, with error status.
    if (responseText.length > this.pos_) {
      const newData = responseText.substr(this.pos_);
      this.pos_ = responseText.length;
      try {
        const messages = this.parser_.parse(newData);
        if (messages != null) {
          if (this.dataHandler_) {
            this.dataHandler_(messages);
          }
        }
      } catch (ex) {
        googLog.error(
            this.logger_, 'Invalid response ' + ex + '\n' + responseText);
        this.updateStatus_(XhrStreamReaderStatus.BAD_DATA);
        this.clear_();
        return;
      }
    }

    if (readyState == XmlHttp.ReadyState.COMPLETE) {
      if (responseText.length == 0) {
        this.updateStatus_(XhrStreamReaderStatus.NO_DATA);
      } else {
        this.updateStatus_(XhrStreamReaderStatus.SUCCESS);
      }
      this.clear_();
      return;
    }

    this.updateStatus_(XhrStreamReaderStatus.ACTIVE);
  }

  /**
   * Returns a parser that supports the given content-type (mime) and
   * content-transfer-encoding.
   *
   * @return {?StreamParser} a parser or null if the content
   *    type or transfer encoding is unsupported.
   * @private
   */
  getParserByResponseHeader_() {
    'use strict';
    let contentType =
        this.xhr_.getStreamingResponseHeader(XhrIo.CONTENT_TYPE_HEADER);
    if (!contentType) {
      googLog.warning(this.logger_, 'Content-Type unavailable: ' + contentType);
      return null;
    }
    contentType = contentType.toLowerCase();

    if (googString.startsWith(contentType, 'application/json')) {
      if (googString.startsWith(contentType, 'application/json+protobuf')) {
        return new PbJsonStreamParser();
      }
      return new JsonStreamParser();
    }

    if (googString.startsWith(contentType, 'application/x-protobuf')) {
      const encoding =
          this.xhr_.getStreamingResponseHeader(XhrIo.CONTENT_TRANSFER_ENCODING);
      if (!encoding) {
        return new PbStreamParser();
      }
      if (encoding.toLowerCase() == 'base64') {
        return new Base64PbStreamParser();
      }
      googLog.warning(
          this.logger_,
          'Unsupported Content-Transfer-Encoding: ' + encoding +
              '\nFor Content-Type: ' + contentType);
      return null;
    }

    googLog.warning(this.logger_, 'Unsupported Content-Type: ' + contentType);
    return null;
  }

  /**
   * Returns the XHR request object.
   * @return {?XhrIo}
   */
  getXhr() {
    'use strict';
    return this.xhr_;
  }

  /**
   * Update the status and may call the handler.
   *
   * @param {!XhrStreamReaderStatus} status The new status
   * @private
   */
  updateStatus_(status) {
    'use strict';
    const current = this.status_;
    if (current != status) {
      this.status_ = status;
      if (this.statusHandler_) {
        this.statusHandler_();
      }
    }
  }


  /**
   * Clears after the XHR terminal state is reached.
   *
   * @private
   */
  clear_() {
    'use strict';
    this.eventHandler_.removeAll();

    if (this.xhr_) {
      // clear out before aborting to avoid being reentered inside abort
      const xhr = this.xhr_;
      this.xhr_ = null;
      xhr.abort();
      xhr.dispose();
    }
  }

  /**
   * Gets the current stream status.
   *
   * @return {!XhrStreamReaderStatus} The stream status.
   */
  getStatus() {
    'use strict';
    return this.status_;
  }

  /**
   * Sets the status handler.
   *
   * @param {function()} handler The handler for any status change.
   */
  setStatusHandler(handler) {
    'use strict';
    this.statusHandler_ = handler;
  }

  /**
   * Sets the data handler.
   *
   * @param {function(!Array<!Object>)} handler The handler for new data.
   */
  setDataHandler(handler) {
    'use strict';
    this.dataHandler_ = handler;
  }

  /**
   * Handles XHR readystatechange events.
   *
   * TODO(user): throttling may be needed.
   *
   * @param {!Event} event The event.
   * @private
   */
  readyStateChangeHandler_(event) {
    'use strict';
    const xhr = /** @type {!XhrIo} */ (event.target);
    try {
      if (xhr == this.xhr_) {
        this.onReadyStateChanged_();
      } else {
        googLog.warning(this.logger_, 'Called back with an unexpected xhr.');
      }
    } catch (ex) {
      googLog.error(
          this.logger_,
          'readyStateChangeHandler_ thrown exception' +
              ' ' + ex);
      // no rethrow
      this.updateStatus_(XhrStreamReaderStatus.HANDLER_EXCEPTION);
      this.clear_();
    }
  }
}


/**
 * Enum type for current stream status.
 * @enum {number}
 */
const XhrStreamReaderStatus = {
  /**
   * Init status, with xhr inactive.
   */
  INIT: 0,

  /**
   * XHR being sent.
   */
  ACTIVE: 1,

  /**
   * The request was successful, after the request successfully completes.
   */
  SUCCESS: 2,

  /**
   * Errors due to a non-200 status code or other error conditions.
   */
  XHR_ERROR: 3,

  /**
   * Errors due to no data being returned.
   */
  NO_DATA: 4,

  /**
   * Errors due to corrupted or invalid data being received.
   */
  BAD_DATA: 5,

  /**
   * Errors due to the handler throwing an exception.
   */
  HANDLER_EXCEPTION: 6,

  /**
   * Errors due to a timeout.
   */
  TIMEOUT: 7,

  /**
   * The request is cancelled by the application.
   */
  CANCELLED: 8,
};

exports = {
  XhrStreamReader,
  XhrStreamReaderStatus
};
