/**
 * Quest 2 dev skript (`scripts/quest-dev.mjs`) bez brýlí: hledání adb, výstup
 * `adb devices`, řádek VrApi a souhrn FPS. Parser, který vrátí cílovou obnovovací
 * frekvenci místo skutečných snímků, nebo souhrn, který z nuly vzorků udělá
 * 0 FPS, by vypadal jako měření – proto vzorky s padajícími snímky.
 */

import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GAME_URL, findAdb, openGameArgs, parseDevices, parseVrApiFps, summarizeFps } from '../quest-dev.mjs';

describe('findAdb', () => {
  const env = { PATH: ['C:\\tools', 'C:\\bin'].join(delimiter), LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  const sdkAdb = join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');

  it('without adb anywhere prints the exact winget command', () => {
    const result = findAdb(env, () => false);
    expect(result).toEqual({ error: expect.stringContaining('winget install Google.PlatformTools') as unknown });
  });

  it('prefers adb on PATH over the SDK folder', () => {
    const onPath = join('C:\\bin', 'adb.exe');
    const present = new Set([onPath, sdkAdb]);
    expect(findAdb(env, (path) => present.has(path))).toEqual({ adb: onPath });
  });

  it('falls back to the Android SDK platform-tools under LOCALAPPDATA', () => {
    expect(findAdb(env, (path) => path === sdkAdb)).toEqual({ adb: sdkAdb });
  });
});

describe('parseDevices', () => {
  it('an empty device list explains developer mode and the USB debugging prompt', () => {
    const result = parseDevices('List of devices attached\r\n\r\n');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('Meta Horizon');
    expect(result.error).toContain('Allow USB debugging');
  });

  it('an unauthorized headset asks to confirm USB debugging in the headset', () => {
    const result = parseDevices('List of devices attached\n1WMHH8ABCD1234\tunauthorized\n\n');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('nepovolily ladění');
    expect(result.error).toContain('Allow USB debugging');
  });

  it('returns the authorized headset and skips daemon chatter', () => {
    const stdout = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'OFFLINE0001\toffline',
      '1WMHH8ABCD1234\tdevice',
      '',
    ].join('\r\n');
    expect(parseDevices(stdout)).toEqual({ serial: '1WMHH8ABCD1234' });
  });
});

describe('openGameArgs', () => {
  it('quotes the URL for the headset shell so `&vrhud=1` survives', () => {
    const args = openGameArgs('1WMHH8ABCD1234');
    expect(GAME_URL).toBe('http://localhost:3165/play?vr=1&vrhud=1');
    expect(args[args.indexOf('-d') + 1]).toBe(`'${GAME_URL}'`);
    expect(args.at(-1)).toBe('com.oculus.browser');
  });
});

describe('parseVrApiFps', () => {
  it('reads the frames rendered, the number before the slash', () => {
    const line =
      '10-27 14:03:11.482  1873  2011 I VrApi   : FPS=72/72,Prd=45ms,Tear=0,Early=0,Stale=0,Stale2/5/10/max=0/0/0/0,VSnc=0,Lat=-1,Fov=0D,CPU4/GPU=2/3,1171/490MHz,OC=FF,TA=0/0/0,SP=N/N/N,Mem=1804MHz,Free=2043MB,PLS=0,Temp=31.0C/0.0C,TW=1.86ms,App=4.27ms,GD=0.00ms,CPU&GPU=8.41ms,LCnt=1,GPU%=0.43,CPU%=0.15(W0.19),DSF=1.00';
    expect(parseVrApiFps(line)).toBe(72);
  });

  it('a dropping frame rate reads the rendered frames, not the refresh target', () => {
    expect(parseVrApiFps('VrApi   : FPS=58/72,Prd=47ms,Tear=0,Early=0,Stale=14')).toBe(58);
  });

  it('a line without FPS is null', () => {
    expect(parseVrApiFps('--------- beginning of main')).toBeNull();
    expect(parseVrApiFps('VrApi   : vrapi_EnterVrMode()')).toBeNull();
  });
});

describe('summarizeFps', () => {
  it('median and nearest-rank 5th percentile of an unsorted sample', () => {
    const samples = Array.from({ length: 40 }, (_, i) => 40 - i);
    expect(summarizeFps(samples)).toEqual({ median: 20.5, p5: 2, samples: 40 });
  });

  it('odd count takes the middle value; one bad second sets p5 of a short run', () => {
    expect(summarizeFps([72, 72, 45, 72, 71])).toEqual({ median: 72, p5: 45, samples: 5 });
  });

  it('zero samples is null, never a fake 0 FPS', () => {
    expect(summarizeFps([])).toBeNull();
  });
});
