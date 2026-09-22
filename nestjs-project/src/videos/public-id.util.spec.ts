import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should return 11 characters from the base64url alphabet', () => {
    const id = generatePublicId();
    expect(id).toHaveLength(11);
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should not repeat across 1000 calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generatePublicId());
    }
    expect(ids.size).toBe(1000);
  });
});
