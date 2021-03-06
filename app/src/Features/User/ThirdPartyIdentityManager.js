const APP_ROOT = '../../../../app/src'
const UserAuditLogHandler = require(`${APP_ROOT}/Features/User/UserAuditLogHandler`)
const EmailHandler = require(`${APP_ROOT}/Features/Email/EmailHandler`)
const Errors = require('../Errors/Errors')
const _ = require('lodash')
const logger = require('logger-sharelatex')
const settings = require('settings-sharelatex')
const { User } = require(`${APP_ROOT}/models/User`)
const { promisifyAll } = require(`${APP_ROOT}/util/promises`)

const oauthProviders = settings.oauthProviders || {}

function _getIndefiniteArticle(providerName) {
  const vowels = ['a', 'e', 'i', 'o', 'u']
  if (vowels.includes(providerName.charAt(0).toLowerCase())) return 'an'
  return 'a'
}

function getUser(providerId, externalUserId, callback) {
  if (providerId == null || externalUserId == null) {
    return callback(new Error('invalid arguments'))
  }
  const query = _getUserQuery(providerId, externalUserId)
  User.findOne(query, function(err, user) {
    if (err != null) {
      return callback(err)
    }
    if (!user) {
      return callback(new Errors.ThirdPartyUserNotFoundError())
    }
    callback(null, user)
  })
}

function login(providerId, externalUserId, externalData, callback) {
  ThirdPartyIdentityManager.getUser(providerId, externalUserId, function(
    err,
    user
  ) {
    if (err != null) {
      return callback(err)
    }
    if (!externalData) {
      return callback(null, user)
    }
    const query = _getUserQuery(providerId, externalUserId)
    const update = _thirdPartyIdentifierUpdate(
      user,
      providerId,
      externalUserId,
      externalData
    )
    User.findOneAndUpdate(query, update, { new: true }, callback)
  })
}

function link(
  userId,
  providerId,
  externalUserId,
  externalData,
  auditLog,
  callback,
  retry
) {
  const accountLinked = true
  if (!oauthProviders[providerId]) {
    return callback(new Error('Not a valid provider'))
  }

  UserAuditLogHandler.addEntry(
    userId,
    'link-sso',
    auditLog.initiatorId,
    auditLog.ipAddress,
    {
      providerId
    },
    error => {
      if (error) {
        return callback(error)
      }
      const query = {
        _id: userId,
        'thirdPartyIdentifiers.providerId': {
          $ne: providerId
        }
      }
      const update = {
        $push: {
          thirdPartyIdentifiers: {
            externalUserId,
            externalData,
            providerId
          }
        }
      }
      // add new tpi only if an entry for the provider does not exist
      // projection includes thirdPartyIdentifiers for tests
      User.findOneAndUpdate(query, update, { new: 1 }, (err, res) => {
        if (err && err.code === 11000) {
          callback(new Errors.ThirdPartyIdentityExistsError())
        } else if (err != null) {
          callback(err)
        } else if (res) {
          _sendSecurityAlert(accountLinked, providerId, res, userId)
          callback(null, res)
        } else if (retry) {
          // if already retried then throw error
          callback(new Error('update failed'))
        } else {
          // attempt to clear existing entry then retry
          ThirdPartyIdentityManager.unlink(
            userId,
            providerId,
            auditLog,
            function(err) {
              if (err != null) {
                return callback(err)
              }
              ThirdPartyIdentityManager.link(
                userId,
                providerId,
                externalUserId,
                externalData,
                auditLog,
                callback,
                true
              )
            }
          )
        }
      })
    }
  )
}

function unlink(userId, providerId, auditLog, callback) {
  const accountLinked = false
  if (!oauthProviders[providerId]) {
    return callback(new Error('Not a valid provider'))
  }
  UserAuditLogHandler.addEntry(
    userId,
    'unlink-sso',
    auditLog.initiatorId,
    auditLog.ipAddress,
    {
      providerId
    },
    error => {
      if (error) {
        return callback(error)
      }
      const query = {
        _id: userId
      }
      const update = {
        $pull: {
          thirdPartyIdentifiers: {
            providerId
          }
        }
      }
      // projection includes thirdPartyIdentifiers for tests
      User.findOneAndUpdate(query, update, { new: 1 }, (err, res) => {
        if (err != null) {
          callback(err)
        } else if (!res) {
          callback(new Error('update failed'))
        } else {
          // no need to wait, errors are logged and not passed back
          _sendSecurityAlert(accountLinked, providerId, res, userId)
          callback(null, res)
        }
      })
    }
  )
}

function _getUserQuery(providerId, externalUserId) {
  externalUserId = externalUserId.toString()
  providerId = providerId.toString()
  const query = {
    'thirdPartyIdentifiers.externalUserId': externalUserId,
    'thirdPartyIdentifiers.providerId': providerId
  }
  return query
}

function _sendSecurityAlert(accountLinked, providerId, user, userId) {
  const operation = accountLinked ? 'linked' : 'no longer linked'
  const tense = accountLinked ? 'was' : 'is'
  const providerName = oauthProviders[providerId].name
  const indefiniteArticle = _getIndefiniteArticle(providerName)
  const emailOptions = {
    to: user.email,
    action: `${providerName} account ${operation}`,
    actionDescribed: `${indefiniteArticle} ${providerName} account ${tense} ${operation} to your account ${
      user.email
    }`
  }
  EmailHandler.sendEmail('securityAlert', emailOptions, error => {
    if (error) {
      logger.error(
        { error, userId },
        `could not send security alert email when ${providerName} ${operation}`
      )
    }
  })
}

function _thirdPartyIdentifierUpdate(
  user,
  providerId,
  externalUserId,
  externalData
) {
  providerId = providerId.toString()
  // get third party identifier object from array
  const thirdPartyIdentifier = user.thirdPartyIdentifiers.find(
    tpi =>
      tpi.externalUserId === externalUserId && tpi.providerId === providerId
  )
  // do recursive merge of new data over existing data
  _.merge(thirdPartyIdentifier.externalData, externalData)
  const update = { 'thirdPartyIdentifiers.$': thirdPartyIdentifier }
  return update
}

const ThirdPartyIdentityManager = {
  getUser,
  login,
  link,
  unlink
}

ThirdPartyIdentityManager.promises = promisifyAll(ThirdPartyIdentityManager)

module.exports = ThirdPartyIdentityManager
