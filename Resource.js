'use strict';

const _ = require('lodash');
const paginate = require('node-paginate-anything');
const jsonpatch = require('fast-json-patch');
const middleware = require( 'composable-middleware');
const mongodb = require('mongodb');
const debug = {
  query: require('debug')('resourcejs:query'),
  index: require('debug')('resourcejs:index'),
  put: require('debug')('resourcejs:put'),
  post: require('debug')('resourcejs:post'),
  delete: require('debug')('resourcejs:delete'),
  respond: require('debug')('resourcejs:respond')
};

class Resource {
  constructor(app, route, modelName, model, options) {
    this.app = app;
    this.options = options || {};
    this.name = modelName.toLowerCase();
    this.model = model;
    this.modelName = modelName;
    this.route = route + '/' + this.name;
    this.methods = [];
    this._swagger = null;
  }

  /**
   * Maintain reverse compatibility.
   *
   * @param app
   * @param method
   * @param path
   * @param callback
   * @param last
   * @param options
   */
  register(app, method, path, callback, last, options) {
    this.app = app;
    return this._register(method, path, callback, last, options);
  }

  /**
   * Register a new callback but add before and after options to the middleware.
   *
   * @param method
   * @param path
   * @param callback
   * @param last
   * @param options
   */
  _register(method, path, callback, last, options) {
    var mw = middleware();
    var len, i;

    // The before middleware.
    if (options && options.before) {
      var before = [].concat(options.before);
      for (len = before.length, i=0; i<len; ++i) {
        mw.use(before[i].bind(this));
      }
    }
    mw.use(callback.bind(this));

    // The after middleware.
    if (options && options.after) {
      var after = [].concat(options.after);
      for (len = after.length, i=0; i<len; ++i) {
        mw.use(after[i].bind(this));
      }
    }
    mw.use(last.bind(this));

    // Add a fallback error handler.
    mw.use((err, req, res, next) => {
      if (err) {
        res.status(500).json({
          status: 500,
          message: err.message || err
        });
      }
      else {
        return next();
      }
    });

    // Declare the resourcejs object on the app.
    if (!this.app.resourcejs) {
      this.app.resourcejs = {};
    }

    if (!this.app.resourcejs[path]) {
      this.app.resourcejs[path] = {};
    }

    // Add these methods to resourcejs object in the app.
    this.app.resourcejs[path][method] = mw;

    // Apply these callbacks to the application.
    this.app[method](path, mw);
  }

  /**
   * Sets the different responses and calls the next middleware for
   * execution.
   *
   * @param res
   *   The response to send to the client.
   * @param next
   *   The next middleware
   */
  respond(req, res, next) {
    if (req.noResponse || res.headerSent || res.headersSent) {
      debug.respond('Skipping');
      return next();
    }

    if (res.resource) {
      switch (res.resource.status) {
        case 400:
          res.status(400).json({
            status: 400,
            message: res.resource.error.message,
            errors: _.mapValues(res.resource.error.errors, function(error) {
              return _.pick(error, 'path', 'name', 'message');
            })
          });
          break;
        case 404:
          res.status(404).json({
            status: 404,
            errors: ['Resource not found']
          });
          break;
        case 500:
          res.status(500).json({
            status: 500,
            message: res.resource.error.message,
            errors: _.mapValues(res.resource.error.errors, function(error) {
              return _.pick(error, 'path', 'name', 'message');
            })
          });
          break;
        case 204:
          // Convert 204 into 200, to preserve the empty result set.
          // Update the empty response body based on request method type.
          debug.respond('204 -> ' + req.__rMethod);
          switch (req.__rMethod) {
            case 'index':
              res.status(200).json([]);
              break;
            default:
              res.status(200).json({});
              break;
          }
          break;
        default:
          res.status(res.resource.status).json(res.resource.item);
          break;
      }
    }

    next();
  }

  /**
   * Sets the response that needs to be made and calls the next middleware for
   * execution.
   *
   * @param res
   * @param resource
   * @param next
   */
  setResponse(res, resource, next) {
    res.resource = resource;
    next();
  }

  /**
   * Returns the method options for a specific method to be executed.
   * @param method
   * @param options
   * @returns {{}}
   */
  getMethodOptions(method, options) {
    if (!options) {
      options = {};
    }

    // If this is already converted to method options then return.
    if (options.methodOptions) {
      return options;
    }

    // Uppercase the method.
    method = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
    var methodOptions = {methodOptions: true};

    // Find all of the options that may have been passed to the rest method.
    if (options.before) {
      methodOptions.before = options.before;
    }
    else if (options.hasOwnProperty('before' + method)) {
      methodOptions.before = options['before' + method];
    }

    if (options.after) {
      methodOptions.after = options.after;
    }
    else if (options.hasOwnProperty('after' + method)) {
      methodOptions.after = options['after' + method];
    }

    // Expose mongoose hooks for each method.
    _.each(['before', 'after'], function(type) {
      var path = 'hooks.' + method.toString().toLowerCase() + '.' + type;

      _.set(
        methodOptions,
        path,
        _.get(options, path, function(req, res, item, next) { return next(); })
      );
    });

    // Return the options for this method.
    return methodOptions;
  }

  /**
   * _register the whole REST api for this resource.
   *
   * @param options
   * @returns {*|null|HttpPromise}
   */
  rest(options) {
    return this
      .index(options)
      .get(options)
      .virtual(options)
      .put(options)
      .patch(options)
      .post(options)
      .delete(options);
  }

  /**
   * Returns a query parameters fields.
   *
   * @param req
   * @param name
   * @returns {*}
   */
  getParamQuery(req, name) {
    if (!req.query.hasOwnProperty(name)) {
      switch (name) {
        case 'populate':
          return '';
        default:
          return null;
      }
    }
    return _.uniq(_.words(req.query[name], /[^, ]+/g)).join(' ');
  }

  getQueryValue(name, value, param) {
    var parsedValue = parseInt(value, 10);

    if (param.instance === 'Number') {
      return parsedValue;
    }

    // If this is a valid ISO Date, convert to date.
    // See https://stackoverflow.com/questions/3143070/javascript-regex-iso-datetime for regex.
    if (
      (typeof value === 'string') &&
      (value.match(/(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))/))
    ) {
      return new Date(value);
    }

    if (param.instance === 'Date' && parsedValue) {
      return new Date(parsedValue);
    }

    // If this is an ID, and the value is a string, convert to an ObjectId.
    if (this.options.convertIds && name.match(/(^|\.)_id$/) && (typeof value === 'string')) {
      try {
        value = new mongodb.ObjectID(value);
      }
      catch (err) {
        console.warn(`Invalid ObjectID: ${value}`);
      }
    }

    return value;
  }

  /**
   * Get the find query for the index.
   *
   * @param req
   * @returns {Object}
   */
  getFindQuery(req) {
    var findQuery = {};

    // Get the filters and omit the limit, skip, select, and sort.
    var filters = _.omit(req.query, 'limit', 'skip', 'select', 'sort', 'populate');

    // Iterate through each filter.
    _.each(filters, (value, name) => {

      // Get the filter object.
      var filter = _.zipObject(['name', 'selector'], name.split('__'));

      // See if this parameter is defined in our model.
      var param = this.model.schema.paths[filter.name.split('.')[0]];
      if (param) {

        // See if there is a selector.
        if (filter.selector) {

          // See if this selector is a regular expression.
          if (filter.selector === 'regex') {

            // Set the regular expression for the filter.
            var parts = value.match(/\/?([^/]+)\/?([^/]+)?/);
            var regex = null;
            try {
              regex = new RegExp(parts[1], (parts[2] || 'i'));
            }
            catch (err) {
              debug.query(err);
              regex = null;
            }
            if (regex) {
              findQuery[filter.name] = regex;
            }
            return;
          }
          else {
            // Init the filter.
            if (!findQuery.hasOwnProperty(filter.name)) {
              findQuery[filter.name] = {};
            }

            if (filter.selector === 'exists') {
              value = ((value === 'true') || (value === '1')) ? true : value;
              value = ((value === 'false') || (value === '0')) ? false : value;
              value = !!value;
            }
            // Special case for in filter with multiple values.
            else if ((_.indexOf(['in', 'nin'], filter.selector) !== -1)) {
              value = _.isArray(value) ? value : value.split(',');
              value = _.map(value, (item) => {
                return this.getQueryValue(filter.name, item, param);
              });
            }
            else {
              // Set the selector for this filter name.
              value = this.getQueryValue(filter.name, value, param);
            }

            findQuery[filter.name]['$' + filter.selector] = value;
            return;
          }
        }
        else {
          // Set the find query to this value.
          value = this.getQueryValue(filter.name, value, param);
          findQuery[filter.name] = value;
          return;
        }
      }

      // Set the find query to this value.
      findQuery[filter.name] = value;
    });

    // Return the findQuery.
    return findQuery;
  }

  countQuery(query, pipeline) {
    // We cannot use aggregation if mongoose special options are used... like populate.
    if (!_.isEmpty(query._mongooseOptions) || !pipeline) {
      return query;
    }
    let stages = [{$match: query.getQuery()}];
    stages = stages.concat(pipeline);
    stages.push({$group: {
      _id : null,
      count : {$sum : 1}
    }});
    return {
      count: (cb) => {
        query.model.aggregate(stages).exec((err, items) => {
          if (err) {
            return cb(err);
          }
          return cb(null, items.length ? items[0].count : 0);
        });
      }
    };
  }

  indexQuery(query, pipeline) {
    // We cannot use aggregation if mongoose special options are used... like populate.
    if (!_.isEmpty(query._mongooseOptions) || !pipeline) {
      return query;
    }
    let stages = [{$match: query.getQuery()}];

    // Add the model pipeline.
    stages = stages.concat(pipeline);

    if (_.has(query, 'options.sort') && !_.isEmpty(query.options.sort)) {
      stages.push({$sort: query.options.sort});
    }
    if (_.has(query, 'options.skip')) {
      stages.push({$skip: query.options.skip});
    }
    if (_.has(query, 'options.limit')) {
      stages.push({$limit: query.options.limit});
    }
    if (!_.isEmpty(query._fields)) {
      stages.push({$project: query._fields});
    }
    return query.model.aggregate(stages);
  }

  /**
   * The index for a resource.
   *
   * @param options
   */
  index(options) {
    options = this.getMethodOptions('index', options);
    this.methods.push('index');
    this._register('get', this.route, (req, res, next) => {
      // Store the internal method for response manipulation.
      req.__rMethod = 'index';

      // Allow before handlers the ability to disable resource CRUD.
      if (req.skipResource) { return next(); }

      // Get the find query.
      var findQuery = this.getFindQuery(req);

      // Get the query object.
      var countQuery = req.countQuery || req.modelQuery || req.model || this.model;
      var query = req.modelQuery || req.model || this.model;

      // First get the total count.
      this.countQuery(countQuery.find(findQuery), query.pipeline).count((err, count) => {
        if (err) {
          debug.index(err);
          return this.setResponse.call(this, res, {status: 500, error: err}, next);
        }

        // Get the default limit.
        var defaults = {limit: 10, skip: 0};
        var reqQuery = _.mapValues(_.defaults(_.pick(req.query, 'limit', 'skip'), defaults), function(value, key) {
          value = parseInt(value, 10);
          return (isNaN(value) || (value < 0)) ? defaults[key] : value;
        });

        // If a skip is provided, then set the range headers.
        if (reqQuery.skip && !req.headers.range) {
          req.headers['range-unit'] = 'items';
          req.headers.range = reqQuery.skip + '-' + (reqQuery.skip + (reqQuery.limit - 1));
        }

        // Get the page range.
        var pageRange = paginate(req, res, count, reqQuery.limit) || {
          limit: reqQuery.limit,
          skip: reqQuery.skip
        };

        // Make sure that if there is a range provided in the headers, it takes precedence.
        if (req.headers.range) {
          reqQuery.limit = pageRange.limit;
          reqQuery.skip = pageRange.skip;
        }

        // Next get the items within the index.
        var queryExec = query
          .find(findQuery)
          .limit(reqQuery.limit)
          .skip(reqQuery.skip)
          .select(this.getParamQuery(req, 'select'))
          .sort(this.getParamQuery(req, 'sort'));

        // Only call populate if they provide a populate query.
        var populate = this.getParamQuery(req, 'populate');
        if (populate) {
          debug.index('Populate: ' + populate);
          queryExec = queryExec.populate(populate);
        }

        options.hooks.index.before.call(
          this,
          req,
          res,
          findQuery,
          () => this.indexQuery(queryExec, query.pipeline).exec((err, items) => {
            if (err) {
              debug.index(err);
              debug.index(err.name);

              if (err.name == 'CastError' && populate) {
                err.message = 'Cannot populate "' + populate + '" as it is not a reference in this resource'
                debug.index(err.message);
              }

              return this.setResponse.call(this, res, {status: 500, error: err}, next);
            }

            debug.index(items);
            options.hooks.index.after.call(
              this,
              req,
              res,
              items,
              this.setResponse.bind(this, res, {status: res.statusCode, item: items}, next)
            );
          })
        )
      });
    }, this.respond.bind(this), options);
    return this;
  }

  /**
   * Register the GET method for this resource.
   */
  get(options) {
    options = this.getMethodOptions('get', options);
    this.methods.push('get');
    this._register('get', this.route + '/:' + this.name + 'Id', function(req, res, next) {
      // Store the internal method for response manipulation.
      req.__rMethod = 'get';
      if (req.skipResource) {
        return next();
      }

      var query = req.modelQuery || req.model || this.model;
      var search = {'_id': req.params[this.name + 'Id']};

      options.hooks.get.before.call(
        this,
        req,
        res,
        search,
        query.findOne.bind(query, search, (err, item) => {
          if (err) return this.setResponse.call(this, res, {status: 500, error: err}, next);
          if (!item) return this.setResponse.call(this, res, {status: 404}, next);

          return options.hooks.get.after.call(
            this,
            req,
            res,
            item,
            this.setResponse.bind(this, res, {status: 200, item: item}, next)
          );
        })
      );
    }, this.respond.bind(this), options);
    return this;
  }

  /**
   * Virtual (GET) method. Returns a user-defined projection (typically an aggregate result)
   * derived from this resource
   */
  virtual(options) {
    options = this.getMethodOptions('virtual', options);
    this.methods.push('virtual');
    var path = (options.path === undefined) ? this.path : options.path;
    this._register('get', this.route + '/virtual/' + path, function(req, res, next) {
      // Store the internal method for response manipulation.
      req.__rMethod = 'virtual';

      if (req.skipResource) { return next(); }
      var query = req.modelQuery || req.model;
      query.exec((err, item) => {
        if (err) return this.setResponse(res, {status: 500, error: err}, next);
        if (!item) return this.setResponse(res, {status: 404}, next);
        return this.setResponse(res, {status: 200, item: item}, next);
      });
    }, this.respond.bind(this), options);
    return this;
  }

  /**
   * Post (Create) a new item
   */
  post(options) {
    options = this.getMethodOptions('post', options);
    this.methods.push('post');
    this._register('post', this.route, (req, res, next) => {
      // Store the internal method for response manipulation.
      req.__rMethod = 'post';

      if (req.skipResource) {
        debug.post('Skipping Resource');
        return next();
      }

      var Model = req.model || this.model;
      var model = new Model(req.body);
      options.hooks.post.before.call(
        this,
        req,
        res,
        req.body,
        model.save.bind(model, (err, item) => {
          if (err) {
            debug.post(err);
            return this.setResponse.call(this, res, {status: 400, error: err}, next);
          }

          debug.post(item);
          // Trigger any after hooks before responding.
          return options.hooks.post.after.call(
            this,
            req,
            res,
            item,
            this.setResponse.bind(this, res, {status: 201, item: item}, next)
          );
        })
      );
    }, this.respond.bind(this), options);
    return this;
  }

  /**
   * Put (Update) a resource.
   */
  put(options) {
    options = this.getMethodOptions('put', options);
    this.methods.push('put');
    this._register('put', this.route + '/:' + this.name + 'Id', function(req, res, next) {
      // Store the internal method for response manipulation.
      req.__rMethod = 'put';

      if (req.skipResource) {
        debug.put('Skipping Resource');
        return next();
      }

      // Remove __v field
      var update = _.omit(req.body, '__v');
      var query = req.modelQuery || req.model || this.model;

      query.findOne({_id: req.params[this.name + 'Id']}, (err, item) => {
        if (err) {
          debug.put(err);
          return this.setResponse.call(this, res, {status: 500, error: err}, next);
        }
        if (!item) {
          debug.put('No ' + this.name + ' found with ' + this.name + 'Id: ' + req.params[this.name + 'Id']);
          return this.setResponse.call(this, res, {status: 404}, next);
        }

        item.set(update);
        options.hooks.put.before.call(
          this,
          req,
          res,
          item,
          item.save.bind(item, (err, item) => {
            if (err) {
              debug.put(err);
              return this.setResponse.call(this, res, {status: 400, error: err}, next);
            }

            debug.put(JSON.stringify(item));
            return options.hooks.put.after.call(
              this,
              req,
              res,
              item,
              this.setResponse.bind(this, res, {status: 200, item: item}, next)
            );
          })
        );
      });
    }, this.respond.bind(this), options);
    return this;
  }

  /**
   * Patch (Partial Update) a resource.
   */
  patch(options) {
    options = this.getMethodOptions('patch', options);
    this.methods.push('patch');
    this._register('patch', this.route + '/:' + this.name + 'Id', function(req, res, next) {
      // Store the internal method for response manipulation.
      req.__rMethod = 'patch';

      if (req.skipResource) { return next(); }
      var query = req.modelQuery || req.model || this.model;
      query.findOne({'_id': req.params[this.name + 'Id']}, (err, item) => {
        if (err) return this.setResponse(res, {status: 500, error: err}, next);
        if (!item) return this.setResponse(res, {status: 404, error: err}, next);
        var patches = req.body;
        try {
          for (var len = patches.length, i=0; i<len; ++i) {
            var patch = patches[i];
            if(patch.op === 'test'){
              var success = jsonpatch.applyPatch(item, [].concat(patch), true);
              if(!success || !success.length){
                return this.setResponse(res, {
                  status: 412,
                  name: 'Precondition Failed',
                  message: 'A json-patch test op has failed. No changes have been applied to the document',
                  item: item,
                  patch: patch
                }, next);
              }
            }
          }
          jsonpatch.applyPatch(item, patches, true);
        } catch(err) {
          if (err && err.name === 'TEST_OPERATION_FAILED') {
            return this.setResponse(res, {
              status: 412,
              name: 'Precondition Failed',
              message: 'A json-patch test op has failed. No changes have been applied to the document',
              item: item,
              patch: patch
            }, next);
          }

          if (err) return this.setResponse(res, {status: 500, item: item, error: err}, next);
        }
        item.save((err, item) => {
          if (err) return this.setResponse(res, {status: 400, error: err}, next);
          return this.setResponse(res, {status: 200, item: item}, next);
        });
      });
    }, this.respond.bind(this), options);
    return this;
  }

  /**
   * Delete a resource.
   */
  delete(options) {
    options = this.getMethodOptions('delete', options);
    this.methods.push('delete');
    this._register('delete', this.route + '/:' + this.name + 'Id', function(req, res, next) {
      // Store the internal method for response manipulation.
      req.__rMethod = 'delete';

      if (req.skipResource) {
        debug.delete('SKipping Resource');
        return next();
      }

      var query = req.modelQuery || req.model || this.model;
      query.findOne({'_id': req.params[this.name + 'Id']}, (err, item) => {
        if (err) {
          debug.delete(err);
          return this.setResponse.call(this, res, {status: 500, error: err}, next);
        }
        if (!item) {
          debug.delete('No ' + this.name + ' found with ' + this.name + 'Id: ' + req.params[this.name + 'Id']);
          return this.setResponse.call(this, res, {status: 404, error: err}, next);
        }
        if (req.skipDelete) {
          return this.setResponse.call(this, res, {status: 204, item: item, deleted: true}, next);
        }

        options.hooks.delete.before.call(
          this,
          req,
          res,
          item,
          query.remove.bind(query, {_id: item._id}, (err) => {
            if (err) {
              debug.delete(err);
              return this.setResponse.call(this, res, {status: 400, error: err}, next);
            }

            debug.delete(item);
            options.hooks.delete.after.call(
              this,
              req,
              res,
              item,
              this.setResponse.bind(this, res, {status: 204, item: item, deleted: true}, next)
            );
          })
        );
      });
    }, this.respond.bind(this), options);
    return this;
  }

  /**
   * Returns the swagger definition for this resource.
   */
  swagger(resetCache) {
    resetCache = resetCache || false;
    if (!this.__swagger || resetCache) {
      this.__swagger = require('./Swagger')(this);
    }
    return this.__swagger;
  }
}

// Make sure to create a new instance of the Resource class.
let ResourceFactory = function(app, route, modelName, model, options) {
  return new Resource(app, route, modelName, model, options);
};

ResourceFactory.Resource = Resource;
module.exports = ResourceFactory;
