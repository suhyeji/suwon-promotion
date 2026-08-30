// Vercel serverless function: fetches the live 2026 K리그2 schedule from the
// official K리그 site and returns aggregated standings + the remaining fixture
// list. All the simulation/magic-number math still runs client-side in
// index.html — this endpoint's only job is "what actually happened / is left".

// 팀 이름은 K리그 공식 API(kleague.com)가 스케줄에 표기하는 이름을 그대로 쓴다 —
// 임의로 풀네임으로 바꿔 부르지 않는다. 이 집합은 유효한 팀만 걸러내는
// 화이트리스트 역할만 한다.
const VALID_TEAMS = new Set([
  "경남", "김포", "김해", "대구", "부산", "서울E", "성남", "수원", "수원FC",
  "안산", "용인", "전남", "천안", "충남아산", "충북청주", "파주", "화성"
]);

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
    if (!stats.has(name)) stats.set(name, { name: name, short: name, gp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, recentRaw: [] });
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
    var hName = g.homeTeamName, aName = g.awayTeamName;
    if (!VALID_TEAMS.has(hName) || !VALID_TEAMS.has(aName) || g.homeGoal == null || g.awayGoal == null) return;
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

  // 최근 5경기 폼(승/무/패)은 K리그 공식 순위표처럼 공식 종료된 경기만 날짜순으로
  // 반영한다 — 진행 중인 경기의 잠정 결과는 폼 배지에 넣지 않는다.
  var finished = games
    .filter(function (g) {
      return g.endYn === "Y" && VALID_TEAMS.has(g.homeTeamName) && VALID_TEAMS.has(g.awayTeamName) &&
        g.homeGoal != null && g.awayGoal != null;
    })
    .sort(function (a, b) {
      return a.roundId - b.roundId || a.gameDate.localeCompare(b.gameDate);
    });
  finished.forEach(function (g) {
    var H = team(g.homeTeamName), A = team(g.awayTeamName);
    var hg = g.homeGoal, ag = g.awayGoal;
    var hResult = hg > ag ? "W" : (hg < ag ? "L" : "D");
    var aResult = hg > ag ? "L" : (hg < ag ? "W" : "D");
    H.recentRaw.push(hResult);
    A.recentRaw.push(aResult);
  });
  stats.forEach(function (t) {
    t.recent = t.recentRaw.slice(-5);
    delete t.recentRaw;
  });

  var fixtures = remaining
    .filter(function (g) { return VALID_TEAMS.has(g.homeTeamName) && VALID_TEAMS.has(g.awayTeamName); })
    .sort(function (a, b) {
      return a.roundId - b.roundId || a.gameDate.localeCompare(b.gameDate);
    })
    .map(function (g) {
      var mmdd = g.gameDate.slice(5).replace(".", "-");
      return [g.roundId, mmdd, g.homeTeamName, g.awayTeamName, g.gameTime || ""];
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

    var now = Date.now();
    var result = buildStandingsAndFixtures(games, now);

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
          awayGoal: finishedSample.awayGoal
        } : null
      });
    }

    // Vercel Functions 응답은 브라우저용 Cache-Control이 아니라 CDN-Cache-Control로
    // 엣지 캐싱을 지시해야 한다 (일반 Cache-Control은 CDN 레이어에 적용되지 않음).
    // 진행 중인 경기가 있으면 30분 캐시로는 잠정 스코어가 너무 오래 묵으니
    // 짧게(60초) 캐시하고, 없으면 K리그 사이트 보호를 위해 30분으로 되돌린다.
    // 다만 "없음"으로 30분 캐시가 걸린 직후에 경기가 킥오프되면, 그 30분 동안
    // 엣지가 "경기 없음" 응답을 계속 내려줘서 새로고침해도 진행중 표시가 하나도
    // 안 뜨는 문제가 생긴다 — 킥오프 예정/직후 30분 구간도 활성 상태로 보고
    // 짧게 캐시해서 이 사각지대를 없앤다.
    var NEAR_KICKOFF_WINDOW = 30 * 60 * 1000;
    var hasNearKickoff = games.some(function (g) {
      if (!g.gameDate || !g.gameTime) return false;
      var iso = g.gameDate.replace(/\./g, "-") + "T" + g.gameTime + ":00+09:00";
      var t = new Date(iso).getTime();
      return !isNaN(t) && Math.abs(now - t) <= NEAR_KICKOFF_WINDOW;
    });
    var hasLive = result.live.length > 0 || hasNearKickoff;
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
