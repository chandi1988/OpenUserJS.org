'use strict';

// Define some pseudo module globals
var isPro = require('../libs/debug').isPro;
var isDev = require('../libs/debug').isDev;
var isDbg = require('../libs/debug').isDbg;

//
var Flag = require('../models/flag').Flag;
var User = require('../models/user').User;
var getKarma = require('./collectiveRating').getKarma;
var thresholds = { 'Script': 1, 'User': 1, 'Discussion': 1, 'Comment': 1 };
var maxKarma = 10;

// Determine whether content can be flagged by a user.
// This is heavily commented so that my logic and
// reasoning is documented for myself and others.
function flaggable(aModel, aContent, aUser, aCallback) {
  // Not logged in or role is above moderator
  // No one above a moderator is part of the moderation system
  // since they can just remove content directly
  if (!aUser || aUser.role < 3) {
    aCallback(false);
    return;
  }

  // You can't flag yourself
  // Only someone less than an admin can be flagged
  //   except system reserved
  // It is not the responsibility of the community
  // to police the site administration
  if (aModel.modelName === 'User') {
    return getFlag(aModel, aContent, aUser, function (aFlag) {
      aCallback(
        aContent._id != aUser._id && aContent.role > 2 && aContent.role !== 6,
          aContent,
            aFlag
      );
    });
  }

  getAuthor(aContent, function (aAuthor) {
    // Content without an author shouldn't exist
    if (!aAuthor) {
      aCallback(false);
      return;
    }

    // You can't flag your own content
    if (aAuthor._id == aUser._id) {
      aCallback(false);
      return;
    }

    // Content belonging to an admin or above cannot be flagged
    //   including system reserved
    if (aAuthor.role < 3 || aAuthor.role === 6) {
      aCallback(aAuthor.role > 2 && aAuthor.role !== 6, aAuthor);
      return;
    }

    // You can't flag something twice
    getFlag(aModel, aContent, aUser, function (aFlag) {
      aCallback(!aFlag, aAuthor, aFlag);
      return;
    });
  });
}
exports.flaggable = flaggable;

function getFlag(aModel, aContent, aUser, aCallback) {
  Flag.findOne({
    'model': aModel.modelName,
    '_contentId': aContent._id,
    '_userId': aUser._id
  }, function (aErr, aFlag) {
    aCallback(aErr || !aFlag ? null : aFlag);
  });
}

function getAuthor(aContent, aCallback) {
  User.findOne({ _id: aContent._authorId }, function (aErr, aAuthor) {
    // Content without an author shouldn't exist
    if (aErr || !aAuthor) {
      aCallback(null);
      return;
    }

    aCallback(aAuthor);
  });
}
exports.getAuthor = getAuthor;

function getThreshold(aModel, aContent, aAuthor, aCallback) {
  // Admins can't be flagged so they have no threshold
  if (aAuthor.role < 3) {
    aCallback(null);
    return;
  }

  // Hardcode the threshold at 1.
  // modelQuery.applyModelListQueryFlaggedFilter supports this hardcoded number.
  // aCallback(1);
  // return;

  // Moderators have a doubled threshold
  var threshold = thresholds[aModel.modelName] * (aAuthor.role < 4 ? 2 : 1);

  // Calculate karma and add it to the threshold
  getKarma(aAuthor, maxKarma, function (aKarma) {
    aCallback(threshold + aKarma);
    return;
  });
}
exports.getThreshold = getThreshold;

function saveContent(aModel, aContent, aAuthor, aFlags, aIsFlagging, aCallback) {
  if (!aContent.flags) {
    aContent.flags = {};
  }

  if (!aContent.flags.critical) {
    aContent.flags.critical = 0;
  }

  if (!aContent.flags.absolute) {
    aContent.flags.absolute = 0;
  }

  aContent.flags.critical += aFlags;

  if (aIsFlagging) {
    aContent.flags.absolute +=
      (aFlags > 0 ? 1 : (aFlags < 0 && aContent.flags.absolute !== 0 ? -1 : 0));
  }

  if (aContent.flags.critical >= thresholds[aModel.modelName] * (aAuthor.role < 4 ? 2 : 1)) {
    return getThreshold(aModel, aContent, aAuthor, function (aThreshold) {
      aContent.flagged = aContent.flags.critical >= aThreshold;

      aContent.save(function (aErr, aContent) {
        if (aErr) {
          console.warn('Error flagging content', aErr);
          aCallback(null);
          return;
        }
        aCallback(aContent.flagged);
      });
    });
  } else {
    aContent.flagged = false;
  }

  aContent.save(function (aErr, aContent) {
    if (aErr) {
      console.warn('Error unflagging content', aErr);
      aCallback(null);
      return;
    }
    aCallback(aContent.flagged);
  });
}
exports.saveContent = saveContent;

function flag(aModel, aContent, aUser, aAuthor, aReason, aCallback) {
  var now = new Date();
  var flag = new Flag({
    'model': aModel.modelName,
    '_contentId': aContent._id,
    '_userId': aUser._id,
    'reason': aReason,
    'created': now
  });

  flag.save(function (aErr, aFlag) {
    // WARNING: No err handling

    if (!aContent.flags) {
      aContent.flags = {};
    }

    if (!aContent.flags.critical) {
      aContent.flags.critical = 0;
    }

    if (!aContent.flags.absolute) {
      aContent.flags.absolute = 0;
    }

    if (!aContent.flagged) {
      aContent.flagged = false;
    }

    saveContent(aModel, aContent, aAuthor, aUser.role < 4 ? 2 : 1, true, aCallback);
  });
}

exports.flag = function (aModel, aContent, aUser, aReason, aCallback) {
  flaggable(aModel, aContent, aUser, function (aCanFlag, aAuthor) {
    if (!aCanFlag) {
      aCallback(false);
      return;
    }

    flag(aModel, aContent, aUser, aAuthor, aReason, aCallback);
  });
};

exports.unflag = function (aModel, aContent, aUser, aReason, aCallback) {
  if (!aUser) {
    aCallback(null);
    return;
  }

  getFlag(aModel, aContent, aUser, function (aFlag) {
    if (!aFlag) {
      aCallback(null);
      return;
    }

    if (!aContent.flags) {
      aContent.flags = {};
    }

    if (!aContent.flags.critical) {
      aContent.flags.critical = 0;
    }

    if (!aContent.flags.absolute) {
      aContent.flags.absolute = 0;
    }

    if (!aContent.flagged) {
      aContent.flagged = false;
    }

    function removeFlag(aAuthor) {
      aFlag.remove(function (aErr) {
        // WARNING: No err handling

        saveContent(aModel, aContent, aAuthor, aUser.role < 4 ? -2 : -1, true, aCallback);
      });
    }

    if (aModel.modelName === 'User') {
      removeFlag(aContent);
    } else {
      getAuthor(aContent, removeFlag);
    }
  });
};
