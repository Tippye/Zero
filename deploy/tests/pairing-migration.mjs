import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const compose = ['compose', '-f', 'deploy/tests/compose.pairing.yaml'];
const database = 'zero_pairing_migration_test';
function sql(query, db = database) {
  const r = spawnSync(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'zero',
      '-d',
      db,
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function migrate(owner) {
  return spawnSync(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      '-e',
      'DATABASE_URL=postgresql://zero:synthetic-pairing-test@db:5432/' + database,
      ...(owner ? ['-e', 'PAIRING_OWNER_ID=' + owner] : []),
      'api',
      'node',
      'migrate.mjs',
    ],
    { encoding: 'utf8' },
  );
}
sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`, 'zero');
sql(`CREATE DATABASE ${database}`, 'zero');
try {
  let r = migrate();
  assert.equal(r.status, 0, r.stderr);
  const owner = sql('SELECT user_id FROM mail0_pairing_owner');
  assert.match(owner, /^[a-f0-9-]+$/);
  sql(`DELETE FROM mail0_pairing_owner;
    UPDATE mail0_user SET name='retained owner' WHERE id='${owner}';
    INSERT INTO mail0_user_hotkeys(user_id,shortcuts,created_at,updated_at) VALUES('${owner}','{"retained":"fixture"}',now(),now());
    INSERT INTO mail0_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES('legacy','legacy','credential','${owner}','synthetic-old-hash',now(),now());
    INSERT INTO mail0_session(id,token,user_id,created_at,updated_at,expires_at) VALUES('old-session','synthetic-old-token','${owner}',now(),now(),now()+interval '1 day');
    INSERT INTO mail0_user(id,name,email,email_verified,is_anonymous,created_at,updated_at) VALUES('other-owner','other','other@example.invalid',true,false,now(),now())`);
  r = migrate();
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('Multiple workspaces'));
  assert.equal(sql('SELECT count(*) FROM mail0_pairing_owner'), '0');
  assert.equal(
    sql('SELECT count(*) FROM mail0_session'),
    '1',
    'failed migration must preserve sessions',
  );
  r = migrate(owner);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sql('SELECT user_id FROM mail0_pairing_owner'), owner);
  assert.equal(sql(`SELECT name FROM mail0_user WHERE id='${owner}'`), 'retained owner');
  assert.equal(
    sql(`SELECT shortcuts->>'retained' FROM mail0_user_hotkeys WHERE user_id='${owner}'`),
    'fixture',
  );
  assert.equal(
    sql('SELECT count(*) FROM mail0_session'),
    '0',
    'first cutover must revoke old sessions',
  );
  assert.equal(sql('SELECT count(*) FROM mail0_user'), '2', 'workspaces must not be deleted');
  sql(
    `INSERT INTO mail0_session(id,token,user_id,created_at,updated_at,expires_at) VALUES('paired','synthetic-paired-token','${owner}',now(),now(),now()+interval '1 day')`,
  );
  r = migrate();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    sql('SELECT count(*) FROM mail0_session'),
    '1',
    'subsequent migration must preserve paired sessions',
  );
  console.log(
    'PASS migration: no login-password configuration, ambiguous owners fail without mutation, explicit existing identity preserved, data retained, old sessions revoked once, subsequent sessions retained.',
  );
} finally {
  sql(`DROP DATABASE ${database} WITH (FORCE)`, 'zero');
}
