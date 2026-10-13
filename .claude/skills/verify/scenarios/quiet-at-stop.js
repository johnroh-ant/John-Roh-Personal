// Bus reaches Berry at Mission Creek at 9:20, stops 20 m past the pole and its
// GPS goes silent (last fix stays 9:20:10) for 9 minutes.
const STOP = 2863;
module.exports = {
  name: 'quiet', start: '2026-10-13T09:19:30-07:00', mode: 'work', duration: 600, readEvery: 60,
  buses(t) {
    if (t < 40) return [{ name: '76084', rd: STOP - 240 + 6 * t, speed: 6 }];
    return [{ name: '76084', rd: STOP + 20, speed: 0, ageSec: t - 40 }];
  },
};
