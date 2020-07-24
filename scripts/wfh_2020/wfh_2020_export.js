const mongojs = require('../../app/src/infrastructure/mongojs')
const { db } = mongojs
const async = require('async')

db.subscriptions.aggregate(
  { $match: { teamName: /(Work From Home|Work from Home)/ } },
  { $unwind: '$member_ids' },
  { $group: { _id: null, memberIds: { $addToSet: '$member_ids' } } },
  function(err, results) {
    if (err || !results.length) {
      throw err
    }

    const userIds = results[0].memberIds

    console.log('Id,First Name,Last Name,Sign Up Date,Emails')

    async.eachLimit(
      userIds,
      10,
      function(userId, callback) {
        db.users.findOne(userId, function(err, user) {
          const emails = user.emails.map(email => email.email)
          console.log(
            `${user._id},${user.first_name || ''},${user.last_name || ''},${
              user.signUpDate
            },${emails.join(',')}`
          )
          callback(err)
        })
      },
      function(err) {
        if (err) {
          throw err
        }

        process.exit(0)
      }
    )
  }
)