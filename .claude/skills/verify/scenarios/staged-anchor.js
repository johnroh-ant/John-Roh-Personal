// A bus laid over at Berry & King (rd 2305) from 9:12, staged for the 9:29
// run; leaves 9:28:30. Rider watches from 9:12.
module.exports = {
  name: 'staged', start: '2026-10-13T09:12:00-07:00', mode: 'work', duration: 1080, readEvery: 90,
  buses(t) {
    if (t < 990) return [{ name: '76084', rd: 2310, speed: 0.1 }];
    return [{ name: '76084', rd: 2310 + 6 * (t - 990), speed: 6 }];
  },
};
