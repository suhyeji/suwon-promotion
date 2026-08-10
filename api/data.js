// Vercel serverless function: fetches the live 2026 K리그2 schedule from the
// official K리그 site and returns aggregated standings + the remaining fixture
// list. All the simulation/magic-number math still runs client-side in
// index.html — this endpoint's only job is "what actually happened / is left".

const NAME_MAP = {
  "경남": "경남FC",
  "김포": "김포FC",
  "김해": "김해FC2008",
  "대구": "대구FC",
  "부산": "부산아이파크",
  "서울E": "서울이랜드",
  "성남": "성남FC",
  "수원": "수원삼성",
  "수원FC": "수원FC",
  "안산": "안산그리너스",
  "용인": "용인FC",
  "전남": "전남드래곤즈",
  "천안": "천안시티",
  "충남아산": "충남아산",
  "충북청주": "충북청주",
  "파주": "파주프런티어",
  "화성": "화성FC"
};

// 2026시즌 K리그2는 2월 개막, 11월 종료 — 시즌 전체를 매번 훑어서 지금까지 치른
// 경기와 남은 경기를 다시 계산한다.
const SEASON_MONTHS = ["02", "03", "04", "05", "06", "07", "08", "09", "10", "11"];

async function fetchMonth(month, debugLog) {
  const res = await fetch("https://www.kleague.com/getScheduleList.do", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Referer": "https://www.kleague.com/schedule.do?leagueId=2",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9"
    },
    body: JSON.stringify({ leagueId: "2", teamId: null, ticketStatus: null, year: "2026", month: month, ticketYn: null })
  });
  const bodyText = await res.text();
  var json;
  try { json = JSON.parse(bodyText); } catch (e) { json = null; }
  if (debugLog) {
    debugLog.push({
      month: month,
      httpStatus: res.status,
      resultCode: json && json.resultCode,
      listLen: json && json.data && json.data.scheduleList ? json.data.scheduleList.length : 0,
      bodySnippet: json ? undefined : bodyText.slice(0, 300)
    });
  }
  if (!res.ok) throw new Error("kleague.com fetch failed for month " + month + ": " + res.status);
  if (!json) throw new Error("kleague.com returned non-JSON for month " + month + ": " + bodyText.slice(0, 200));
  if (json.resultCode !== "200") throw new Error("kleague.com API error: " + json.resultMsg);
  return json.data.scheduleList;
}

// endYn이 아직 "N"이어도 킥오프 시각이 이미 지났으면 경기 중(또는 종료 반영 지연)으로 보고,
// K리그 공식 홈페이지처럼 현재(잠정) 스코어를 순위표에 그대로 반영한다.
function hasKickedOff(g, now) {
  if (!g.gameDate || !g.gameTime) return false;
  var iso = g.gameDate.replace(/\./g, "-") + "T" + g.gameTime + ":00+09:00"; // KST
  var t = new Date(iso).getTime();
  return !isNaN(t) && now >= t;
}

function buildStandingsAndFixtures(games, now) {
  const stats = new Map();
  function team(name) {
    if (!stats.has(name)) stats.set(name, { name: name, short: name, gp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
    return stats.get(name);
  }

  var maxRound = 0;
  var live = [];

  // 순위표에 반영할 경기: 공식 종료(Y) + 킥오프가 지났지만 아직 진행/미확정(N)인 경기(잠정 스코어)
  var counted = games.filter(function (g) {
    return g.endYn === "Y" || (g.endYn === "N" && hasKickedOff(g, now));
  });
  // 잔여 대진표: 아직 시작하지 않은 경기만
  var remaining = games.filter(function (g) {
    return g.endYn === "N" && !hasKickedOff(g, now);
  });

  counted.forEach(function (g) {
    var hName = NAME_MAP[g.homeTeamName], aName = NAME_MAP[g.awayTeamName];
    if (!hName || !aName || g.homeGoal == null || g.awayGoal == null) return;
    if (g.endYn === "Y") maxRound = Math.max(maxRound, g.roundId);
    var H = team(hName), A = team(aName);
    var hg = g.homeGoal, ag = g.awayGoal;
    H.gp++; A.gp++;
    H.gf += hg; H.ga += ag; A.gf += ag; A.ga += hg;
    if (hg > ag) { H.w++; H.pts += 3; A.l++; }
    else if (hg < ag) { A.w++; A.pts += 3; H.l++; }
    else { H.d++; A.d++; H.pts += 1; A.pts += 1; }
    if (g.endYn === "N") {
      live.push({ round: g.roundId, home: hName, away: aName, homeGoal: hg, awayGoal: ag });
    }
  });

  var fixtures = remaining
    .filter(function (g) { return NAME_MAP[g.homeTeamName] && NAME_MAP[g.awayTeamName]; })
    .sort(function (a, b) {
      return a.roundId - b.roundId || a.gameDate.localeCompare(b.gameDate);
    })
    .map(function (g) {
      var mmdd = g.gameDate.slice(5).replace(".", "-");
      return [g.roundId, mmdd, NAME_MAP[g.homeTeamName], NAME_MAP[g.awayTeamName], g.gameTime || ""];
    });

  return { teams: Array.from(stats.values()), fixtures: fixtures, asOfRound: maxRound, live: live };
}

module.exports = async function handler(req, res) {
  var debug = req.query && req.query.debug;
  var debugLog = debug ? [] : null;
  try {
    var monthLists = await Promise.all(SEASON_MONTHS.map(function (m) { return fetchMonth(m, debugLog); }));
    var byId = new Map();
    monthLists.flat().forEach(function (g) { byId.set(g.gameId, g); });
    var games = Array.from(byId.values());

    var result = buildStandingsAndFixtures(games, Date.now());

    if (debug) {
      var finishedSample = games.filter(function (g) { return g.endYn === "Y"; })[0];
      debugLog.push({
        gamesTotal: games.length,
        finishedCount: games.filter(function (g) { return g.endYn === "Y"; }).length,
        remainingCount: games.filter(function (g) { return g.endYn === "N"; }).length,
        liveCount: result.live.length,
        sample: finishedSample ? {
          homeTeamName: finishedSample.homeTeamName,
          awayTeamName: finishedSample.awayTeamName,
          endYn: finishedSample.endYn,
          homeGoal: finishedSample.homeGoal,
          awayGoal: finishedSample.awayGoal,
          mappedHome: NAME_MAP[finishedSample.homeTeamName],
          mappedAway: NAME_MAP[finishedSample.awayTeamName]
        } : null
      });
    }

    // Vercel Functions 응답은 브라우저용 Cache-Control이 아니라 CDN-Cache-Control로
    // 엣지 캐싱을 지시해야 한다 (일반 Cache-Control은 CDN 레이어에 적용되지 않음).
    // 진행 중인 경기가 있으면 30분 캐시로는 잠정 스코어가 너무 오래 묵으니
    // 짧게(60초) 캐시하고, 없으면 K리그 사이트 보호를 위해 30분으로 되돌린다.
    var hasLive = result.live.length > 0;
    var sMaxAge = hasLive ? 60 : 1800;
    var swr = hasLive ? 120 : 3600;
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.setHeader("CDN-Cache-Control", "public, s-maxage=" + sMaxAge + ", stale-while-revalidate=" + swr);
    res.status(200).json(Object.assign({
      teams: result.teams,
      fixtures: result.fixtures,
      asOfRound: result.asOfRound,
      live: result.live,
      fetchedAt: new Date().toISOString()
    }, debug ? { debug: debugLog } : {}));
  } catch (err) {
    res.status(502).json(Object.assign(
      { error: String(err && err.message || err) },
      debug ? { debug: debugLog } : {}
    ));
  }
};
