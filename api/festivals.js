// 서울(icn1) 리전에서 실행되어, 공공데이터포털 TourAPI를 대신 호출해주는 프록시 함수.
// GitHub Actions(해외 서버)가 apis.data.go.kr에 직접 접속하면 차단당하는 문제를
// 우회하기 위해, 한국 위치인 이 함수가 대신 호출하고 결과만 돌려준다.
//
// ?mode=nature 를 붙이면 축제(searchFestival2) 대신 자연관광지(areaBasedList2 +
// 자연관광지 카테고리)를 조회한다 — 수목원·공원·자연휴양림 지도용으로 추가됨.
//
// ?mode=shelter 를 붙이면 TourAPI가 아니라 별도 기관(행정안전부 생활안전지도,
// safemap.go.kr)의 무더위쉼터 API(IF_0001)를 호출한다. TOUR_API_KEY와는
// 완전히 다른 별도 인증키(SAFEMAP_API_KEY)가 필요하다.

const FESTIVAL_URL = 'https://apis.data.go.kr/B551011/KorService2/searchFestival2';
const AREA_LIST_URL = 'https://apis.data.go.kr/B551011/KorService2/areaBasedList2';

// safemap.go.kr(생활안전지도) 무더위쉼터 오픈API. 공식 샘플 코드가 http(80포트)로
// 호출하고 있고 이 서버가 별도 인증서를 요구할 가능성이 있어 그대로 http를 따른다.
const SHELTER_URL = 'http://safemap.go.kr/openapi2/IF_0001';
// 무더위쉼터 API 응답(XML)에서 실제로 내려오는 항목 필드명 — safemap.go.kr
// "오픈API Data" 상세페이지의 출력결과(Response Element) 표에서 확인한 값 그대로.
const SHELTER_FIELDS = [
  'num', 'buld_sn', 'cc_nm', 'cc_type', 'rn_adres', 'adres',
  'tot_ar', 'use_num', 'hv_ef', 'hv_ac', 'rest_at', 'night_at',
  'weekend_at', 'lodge_at', 'x', 'y'
];

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// [FIX] 페이지 하나를 가져오다 순간적으로 연결이 실패해도(네트워크 순단 등),
// 전체를 처음부터 다시 시도하지 않고 그 페이지만 짧게 재시도하도록 분리.
async function fetchWithRetry(url, options, maxRetries = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

// safemap.go.kr은 TourAPI와 달리 XML만 안정적으로 지원하는 것으로 보여(요청 파라미터
// 문서상 JSON도 명시되어 있긴 하나, 실제 동작이 검증된 건 XML 샘플뿐이라 XML로 호출하고
// 여기서 JSON으로 변환한다). Node 환경에 별도 XML 파서 패키지를 새로 추가하면 배포/빌드
// 리스크가 늘어나므로, 필드가 평평(flat)하고 목록이 정해져 있는 이 API 특성에 맞춰
// 가벼운 정규식 기반 추출로 처리한다.
function decodeXmlEntities(str) {
  return str
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function extractXmlTag(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}

function parseShelterXmlItems(xmlText) {
  const itemBlocks = xmlText.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
  return itemBlocks.map((block) => {
    const obj = {};
    for (const field of SHELTER_FIELDS) {
      obj[field] = extractXmlTag(block, field);
    }
    return obj;
  });
}

// [FIX] 전국 무더위쉼터가 9만3천여 건(2026년 기준)이나 되어, 이 함수 안에서 전체
// 페이지를 끝까지 다 도는 방식으로는 Vercel 함수 실행시간을 넘겨 타임아웃이 난다
// (실제로 발생: GitHub Actions 쪽에서 30초 read timeout으로 3회 재시도 후 실패).
// 그래서 페이지네이션 자체를 이 함수가 아니라 호출하는 쪽(파이썬)이 pageNo를 넘겨가며
// 여러 번 나눠 부르는 방식으로 바꾸고, 여기서는 요청받은 딱 한 페이지만 처리해서
// 바로 돌려준다 — 왕복 하나하나는 항상 짧게 끝나므로 타임아웃 위험이 사라진다.
async function handleShelterRequest(req, res) {
  const shelterApiKey = process.env.SAFEMAP_API_KEY;
  if (!shelterApiKey) {
    res.status(500).json({ error: 'SAFEMAP_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  const pageNoRaw = parseInt(req.query.pageNo, 10);
  const pageNo = Number.isFinite(pageNoRaw) && pageNoRaw > 0 ? pageNoRaw : 1;
  const numOfRowsRaw = parseInt(req.query.numOfRows, 10);
  // safemap.go.kr 쪽의 실제 상한을 문서에서 확인 못 했으니, 과도한 값으로 요청해서
  // 오히려 응답이 느려지는 일이 없도록 방어적으로 1000건까지만 허용한다.
  const numOfRows = Number.isFinite(numOfRowsRaw) && numOfRowsRaw > 0
    ? Math.min(numOfRowsRaw, 1000)
    : 100;

  try {
    const url = new URL(SHELTER_URL);
    url.searchParams.set('serviceKey', shelterApiKey);
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('numOfRows', String(numOfRows));
    url.searchParams.set('returnType', 'xml');

    const response = await fetchWithRetry(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    }, 2);

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`safemap.go.kr HTTP ${response.status} | ${bodyText.slice(0, 200)}`);
    }

    const xmlText = await response.text();
    const items = parseShelterXmlItems(xmlText);
    const totalCount = Number(extractXmlTag(xmlText, 'totalCount') || 0);

    if (items.length === 0 && pageNo === 1) {
      // 첫 페이지부터 0건이면 진짜 오류일 가능성이 높으니, 원인 파악에 쓸 수 있도록
      // resultCode/resultMsg와 응답 앞부분을 로그로 남겨둔다.
      const resultCode = extractXmlTag(xmlText, 'resultCode');
      const resultMsg = extractXmlTag(xmlText, 'resultMsg');
      console.error(
        `safemap.go.kr 무더위쉼터 응답에 item이 없음 (resultCode=${resultCode || '?'}, `
        + `resultMsg=${resultMsg || '?'}) | 응답 앞부분: ${xmlText.slice(0, 300)}`
      );
    }

    res.status(200).json({ items, totalCount, pageNo, numOfRows });
  } catch (err) {
    const causeDetail = err && err.cause
      ? ` | cause: ${err.cause.code || err.cause.message || String(err.cause)}`
      : '';
    const message = String(err && err.message ? err.message : err) + causeDetail;
    console.error(`festivals.js 오류 (mode=shelter, pageNo=${pageNo}):`, message);
    res.status(502).json({ error: message });
  }
}


export default async function handler(req, res) {
  const mode = req.query.mode === 'nature'
    ? 'nature'
    : (req.query.mode === 'shelter' ? 'shelter' : 'festival');

  if (mode === 'shelter') {
    return handleShelterRequest(req, res);
  }

  const apiKey = process.env.TOUR_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'TOUR_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  const allItems = [];
  let pageNo = 1;
  const numOfRows = mode === 'nature' ? 100 : 200;

  try {
    while (true) {
      const url = new URL(mode === 'nature' ? AREA_LIST_URL : FESTIVAL_URL);
      url.searchParams.set('serviceKey', apiKey);
      url.searchParams.set('numOfRows', String(numOfRows));
      url.searchParams.set('pageNo', String(pageNo));
      url.searchParams.set('MobileOS', 'ETC');
      url.searchParams.set('MobileApp', 'hohoplay');
      url.searchParams.set('_type', 'json');
      url.searchParams.set('arrange', 'A');

      if (mode === 'nature') {
        // 자연관광지: 국립/도립/군립공원, 자연휴양림, 수목원
        url.searchParams.set('contentTypeId', '12');
        url.searchParams.set('cat1', 'A01');
        url.searchParams.set('cat2', 'A0101');
      } else {
        let eventStartDate = req.query.from;
        if (!eventStartDate) {
          const from = new Date();
          from.setDate(from.getDate() - 30);
          eventStartDate = formatDate(from);
        }
        url.searchParams.set('eventStartDate', eventStartDate);
      }

      const response = await fetchWithRetry(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                        + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      }, 2);

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`TourAPI HTTP ${response.status} | ${bodyText.slice(0, 200)}`);
      }

      const data = await response.json();
      const header = data?.response?.header;
      if (!header || (header.resultCode !== '0000' && header.resultCode !== '00')) {
        throw new Error(`TourAPI 오류 응답: ${header?.resultMsg || '알 수 없음'}`);
      }

      const body = data?.response?.body;
      const totalCount = Number(body?.totalCount || 0);
      const items = body?.items;
      let itemList = [];
      if (items && items !== '') {
        itemList = Array.isArray(items.item) ? items.item : (items.item ? [items.item] : []);
      }
      allItems.push(...itemList);

      if (pageNo * numOfRows >= totalCount || itemList.length === 0) {
        break;
      }
      pageNo += 1;
    }

    res.status(200).json({ items: allItems, totalCount: allItems.length });
  } catch (err) {
    const causeDetail = err && err.cause
      ? ` | cause: ${err.cause.code || err.cause.message || String(err.cause)}`
      : '';
    const message = String(err && err.message ? err.message : err) + causeDetail;
    console.error(`festivals.js 오류 (mode=${mode}, pageNo=${pageNo}):`, message);
    res.status(502).json({ error: message });
  }
}
