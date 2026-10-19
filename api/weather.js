// api/weather.js
// 기상청 단기예보 조회서비스(동네예보)로 특정 좌표(lat/lng)의 강수확률(POP)을 가져오는
// Vercel 서버리스 함수.
//
// 사용법: GET /api/weather?lat=37.456&lng=126.705
//
// 필요한 환경변수:
//   KMA_API_KEY — 공공데이터포털 "기상청_단기예보 조회서비스"에서 발급받은 일반 인증키.
//                 Vercel 프로젝트(festival-api-proxy)의 Environment Variables에
//                 이미 등록돼 있다고 가정한다. 이 키는 공공데이터포털이 보여주는 그대로
//                 (URL 인코딩된 "Encoding" 버전) 저장돼 있어야 한다 — 이 코드는 serviceKey를
//                 다시 인코딩하지 않고 URL에 그대로 이어붙인다(이중 인코딩 방지).
//
// 응답 형식 (200 OK):
//   {
//     nx, ny,                // 변환된 기상청 격자 좌표
//     base_date, base_time,  // 이번 조회에 쓰인 발표 시각
//     willRain: boolean,     // 강수확률이 RAIN_THRESHOLD(기본 60%) 이상인 시간대가 있으면 true
//     maxPop: number,        // 조회된 시간대 중 최대 강수확률(%)
//     maxPopTime: string,    // 그 최대값이 나온 "YYYYMMDD HHmm"
//     forecast: [{ date, time, pop }, ...]  // 전체 POP 시계열
//   }
//
// 프런트(festival/index.html)에서의 사용 예:
//   fetch(`https://festival-api-proxy.vercel.app/api/weather?lat=${lat}&lng=${lng}`)
//     .then(r => r.json())
//     .then(d => { if (d.willRain) { /* 배너 표시 + 실내 필터 자동 ON */ } });
//
// 참고: 날씨는 시/군 단위면 충분하다는 전제라, 장소 하나하나의 정밀 좌표가 아니라
// "현재 지도에서 보고 있는 지역의 대표 좌표"를 넘겨주면 된다 — 요청하신 대로 좌표 정밀도
// 이슈와는 무관하게 동작한다.

const BASE_TIMES = ['0200', '0500', '0800', '1100', '1400', '1700', '2000', '2300'];
const RAIN_THRESHOLD = 60; // 강수확률 60% 이상이면 "비 예보"로 간주

// 기상청 단기예보 API는 위경도가 아니라 5km 격자(nx, ny) 좌표를 쓴다.
// 기상청이 공개한 Lambert Conformal Conic 변환식(DFS_XY_CONV, 공식 샘플 코드 그대로)을 사용한다.
function dfsXyConv(lat, lon) {
  const RE = 6371.00877; // 지구 반경(km)
  const GRID = 5.0; // 격자 간격(km)
  const SLAT1 = 30.0; // 투영 위도1(degree)
  const SLAT2 = 60.0; // 투영 위도2(degree)
  const OLON = 126.0; // 기준점 경도(degree)
  const OLAT = 38.0; // 기준점 위도(degree)
  const XO = 43; // 기준점 X좌표(GRID)
  const YO = 136; // 기준점 Y좌표(GRID)

  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  const ra0 = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  const ra = (re * sf) / Math.pow(ra0, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const nx = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const ny = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
  return { nx, ny };
}

// 단기예보는 하루 8번(02,05,08,11,14,17,20,23시) 발표되고, 발표 후 약 10분 뒤부터 조회 가능하다.
// 현재 KST 시각 기준으로 "조회 가능한 가장 최근 발표 시각"을 계산한다.
function getBaseDateTime() {
  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000); // UTC+9로 밀어서 KST 시각처럼 다룬다
  const hh = nowKst.getUTCHours();
  const mm = nowKst.getUTCMinutes();

  let chosen = null;
  for (let i = BASE_TIMES.length - 1; i >= 0; i--) {
    const bt = BASE_TIMES[i];
    const btH = parseInt(bt.slice(0, 2), 10);
    const btM = parseInt(bt.slice(2, 4), 10);
    if (hh > btH || (hh === btH && mm >= btM + 10)) {
      chosen = bt;
      break;
    }
  }

  if (chosen) {
    const dateStr = nowKst.toISOString().slice(0, 10).replace(/-/g, '');
    return { base_date: dateStr, base_time: chosen };
  }

  // 00:00~02:09 사이: 아직 오늘 첫 발표(02시) 전이므로 어제 23시 발표를 쓴다.
  const yesterday = new Date(nowKst.getTime() - 24 * 60 * 60 * 1000);
  const dateStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
  return { base_date: dateStr, base_time: '2300' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { lat, lng } = req.query;
  if (!lat || !lng) {
    res.status(400).json({ error: 'lat, lng 쿼리 파라미터가 필요합니다.' });
    return;
  }

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
    res.status(400).json({ error: 'lat, lng 값이 올바르지 않습니다.' });
    return;
  }

  const apiKey = process.env.KMA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'KMA_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  const { nx, ny } = dfsXyConv(latNum, lngNum);
  const { base_date, base_time } = getBaseDateTime();

  // serviceKey는 공공데이터포털이 준 "Encoding" 값을 그대로 붙인다 — 이미 URL 인코딩된
  // 문자열이므로 encodeURIComponent로 다시 감싸면 이중 인코딩되어 인증에 실패한다.
  const url =
    `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst` +
    `?serviceKey=${apiKey}` +
    `&pageNo=1&numOfRows=1000&dataType=JSON` +
    `&base_date=${base_date}&base_time=${base_time}` +
    `&nx=${nx}&ny=${ny}`;

  try {
    const upstream = await fetch(url);
    const text = await upstream.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      // 기상청 API는 키 오류 등이 있으면 JSON 대신 XML 에러를 돌려주는 경우가 있다.
      res.status(502).json({ error: '기상청 API 응답을 해석하지 못했습니다.', raw: text.slice(0, 300) });
      return;
    }

    const header = data && data.response && data.response.header;
    if (!header || header.resultCode !== '00') {
      res.status(502).json({ error: '기상청 API 오류', detail: header });
      return;
    }

    const items = (data.response.body && data.response.body.items && data.response.body.items.item) || [];
    const popItems = items.filter((it) => it.category === 'POP');

    let maxPop = 0;
    let maxPopTime = null;
    const forecast = popItems.map((it) => {
      const pop = parseInt(it.fcstValue, 10);
      if (pop > maxPop) {
        maxPop = pop;
        maxPopTime = `${it.fcstDate} ${it.fcstTime}`;
      }
      return { date: it.fcstDate, time: it.fcstTime, pop };
    });

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.status(200).json({
      nx,
      ny,
      base_date,
      base_time,
      willRain: maxPop >= RAIN_THRESHOLD,
      maxPop,
      maxPopTime,
      forecast,
    });
  } catch (err) {
    res.status(502).json({ error: '기상청 API 호출에 실패했습니다.', detail: String(err) });
  }
};
