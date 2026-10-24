import { describe, expect, it } from 'vitest';
import { applyClients } from '../src/server/services/xray-service';

/**
 * Per-user traffic accounting depends entirely on the `clients` array carrying
 * an `email`: Xray emits `user>>>EMAIL>>>traffic>>>uplink`, and that string is
 * the only key the worker can attribute bytes by.
 *
 * Shadowsocks is the case that broke. Before this was fixed, the inbound carried
 * `{ method, password }` with NO clients array, so the busiest configuration on
 * the node (2.6 MB down, measured live) produced zero `user>>>` counters and the
 * panel could never count a single byte of it.
 *
 * Getting the shape wrong is either SILENT or FATAL:
 *   - no `email`                     → no counter, traffic silently unattributed
 *   - inbound `method` beside clients → Xray refuses to start the whole node
 */
describe('applyClients — per-user accounting', () => {
  const assignments = [
    { id: 'cmul12n84000r83v3kign4yk2', credential: { password: 'user-one-password' } },
    { id: 'cmul0ygh7000783v354unumcr', credential: { password: 'user-two-password' } },
  ];

  describe('Shadowsocks', () => {
    const settings = { method: 'chacha20-ietf-poly1305', password: 'server-password', network: 'tcp,udp' };

    it('gives every client an email, which is what creates the counter', () => {
      const result = applyClients('SHADOWSOCKS', settings, assignments);
      const clients = result.clients as Record<string, unknown>[];

      expect(clients).toHaveLength(2);
      for (const client of clients) {
        expect(client.email).toBeTypeOf('string');
        expect(String(client.email).startsWith('vp-')).toBe(true);
      }
      expect(clients.map((c) => c.email)).toEqual([
        'vp-cmul12n84000r83v3kign4yk2',
        'vp-cmul0ygh7000783v354unumcr',
      ]);
    });

    it('moves the cipher ONTO each client — Xray rejects it at the inbound level beside clients', () => {
      const result = applyClients('SHADOWSOCKS', settings, assignments);
      const clients = result.clients as Record<string, unknown>[];

      for (const client of clients) {
        expect(client.method).toBe('chacha20-ietf-poly1305');
      }
    });

    it('removes the inbound-level method and password', () => {
      const result = applyClients('SHADOWSOCKS', settings, assignments);

      expect(result).not.toHaveProperty('method');
      expect(result).not.toHaveProperty('password');
      // The transport setting must survive.
      expect(result.network).toBe('tcp,udp');
    });

    it('keeps each user password distinct — one credential per assignment', () => {
      const result = applyClients('SHADOWSOCKS', settings, assignments);
      const clients = result.clients as Record<string, unknown>[];
      expect(clients[0]!.password).toBe('user-one-password');
      expect(clients[1]!.password).toBe('user-two-password');
    });

    it('does not bleed one user credential into another', () => {
      const result = applyClients('SHADOWSOCKS', settings, assignments);
      const clients = result.clients as Record<string, unknown>[];
      expect(clients[0]!.password).not.toBe(clients[1]!.password);
    });

    it('still works when the inbound had no method to copy (defensive)', () => {
      const result = applyClients('SHADOWSOCKS', { network: 'tcp,udp' }, assignments);
      const clients = result.clients as Record<string, unknown>[];
      expect(clients).toHaveLength(2);
      expect(clients[0]!.email).toBeTypeOf('string');
    });
  });

  describe('VLESS', () => {
    const settings = { clients: [], decryption: 'none' };

    it('keys each client on its uuid and email', () => {
      const result = applyClients(
        'VLESS',
        settings,
        [{ id: 'assign-one', credential: { uuid: '11111111-1111-1111-1111-111111111111' } }],
      );
      const clients = result.clients as Record<string, unknown>[];
      expect(clients[0]).toEqual({
        id: '11111111-1111-1111-1111-111111111111',
        email: 'vp-assign-one',
      });
    });

    it('leaves non-credential settings untouched', () => {
      const result = applyClients('VLESS', settings, []);
      expect(result.decryption).toBe('none');
    });
  });

  describe('VMess', () => {
    it('includes alterId and a security default', () => {
      const result = applyClients(
        'VMESS',
        {},
        [{ id: 'assign-two', credential: { uuid: '22222222-2222-2222-2222-222222222222', alterId: 4 } }],
      );
      const clients = result.clients as Record<string, unknown>[];
      expect(clients[0]).toEqual({
        id: '22222222-2222-2222-2222-222222222222',
        alterId: 4,
        security: 'auto',
        email: 'vp-assign-two',
      });
    });
  });

  describe('Trojan', () => {
    it('keys each client on its password and email', () => {
      const result = applyClients(
        'TROJAN',
        {},
        [{ id: 'assign-three', credential: { password: 'trojan-secret' } }],
      );
      const clients = result.clients as Record<string, unknown>[];
      expect(clients[0]).toEqual({ password: 'trojan-secret', email: 'vp-assign-three' });
    });
  });

  it('never emits a client without an email — for any protocol', () => {
    for (const protocol of ['VLESS', 'VMESS', 'TROJAN', 'SHADOWSOCKS']) {
      const result = applyClients(
        protocol,
        { method: 'chacha20-ietf-poly1305' },
        [{ id: 'x', credential: { uuid: '33333333-3333-3333-3333-333333333333', password: 'p' } }],
      );
      const clients = result.clients as Record<string, unknown>[];
      expect(clients.length, protocol).toBeGreaterThan(0);
      for (const client of clients) {
        expect(client.email, `${protocol} client must carry an email`).toBeTruthy();
      }
    }
  });
});
