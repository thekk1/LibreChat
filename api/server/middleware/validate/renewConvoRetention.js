const { logger } = require('@librechat/data-schemas');
const { renewConversationRetention } = require('~/models');

/**
 * Counts a new message as activity under `interface.renewRetentionOnActivity`. Runs after
 * `validateConvoAccess`, and hands the new deadline to the turn's writes through
 * `req.resolvedConversation`, so they do not stamp the old one.
 */
const renewConvoRetention = async (req, _res, next) => {
  const conversation = req.resolvedConversation;
  if (conversation == null) {
    return next();
  }
  try {
    const expiredAt = await renewConversationRetention(
      { userId: req.user?.id ?? '', interfaceConfig: req.config?.interfaceConfig },
      conversation.conversationId,
    );
    if (expiredAt != null) {
      req.resolvedConversation = { ...conversation, expiredAt, isTemporary: false };
    }
  } catch (error) {
    logger.error('[renewConvoRetention] Error renewing conversation retention', error);
  }
  next();
};

module.exports = renewConvoRetention;
