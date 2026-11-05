const mockRenew = jest.fn();

jest.mock('@librechat/data-schemas', () => ({ logger: { error: jest.fn() } }));
jest.mock('~/models', () => ({ renewConversationRetention: mockRenew }));

const { logger } = require('@librechat/data-schemas');
const renewConvoRetention = require('./renewConvoRetention');

const interfaceConfig = { renewRetentionOnActivity: true };

function createRequest(resolvedConversation) {
  return { user: { id: 'user' }, config: { interfaceConfig }, resolvedConversation };
}

describe('renewConvoRetention', () => {
  const next = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([[null], [undefined]])('skips a request with conversation %s', async (conversation) => {
    await renewConvoRetention(createRequest(conversation), {}, next);
    expect(mockRenew).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("hands the new deadline to the turn's writes", async () => {
    const expiredAt = new Date('2027-01-01T00:00:00Z');
    mockRenew.mockResolvedValue(expiredAt);
    const req = createRequest({ conversationId: 'chat', expiredAt: new Date(0) });
    await renewConvoRetention(req, {}, next);
    expect(mockRenew).toHaveBeenCalledWith({ userId: 'user', interfaceConfig }, 'chat');
    expect(req.resolvedConversation).toMatchObject({ expiredAt, isTemporary: false });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored deadline when nothing was renewed', async () => {
    mockRenew.mockResolvedValue(null);
    const conversation = { conversationId: 'chat', expiredAt: new Date(0) };
    const req = createRequest(conversation);
    await renewConvoRetention(req, {}, next);
    expect(req.resolvedConversation).toBe(conversation);
  });

  it('does not fail the turn when the renewal fails', async () => {
    mockRenew.mockRejectedValue(new Error('database down'));
    const conversation = { conversationId: 'chat' };
    const req = createRequest(conversation);
    await renewConvoRetention(req, {}, next);
    expect(logger.error).toHaveBeenCalled();
    expect(req.resolvedConversation).toBe(conversation);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
