// Field report 2026-10-13: 9:19 bus 320 m before Berry at Mission Creek (rd 2863),
// early for the 9:29 trip; reaches the stop ~9:20, holds just past the pole
// until 9:30:30, then departs.
const STOP = 2863;
module.exports = {
  name: 's1', start: '2026-10-13T09:19:00-07:00', mode: 'work', duration: 780, readEvery: 30,
  buses(t) {
    let rd, speed;
    if (t < 53) { rd = STOP - 320 + 6 * t; speed = 6; }
    else if (t < 690) { rd = STOP + 12; speed = 0.2; }
    else { rd = STOP + 12 + 6 * (t - 690); speed = 6; }
    return [{ name: '76084', rd, speed }];
  },
};
