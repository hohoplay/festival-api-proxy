// 서울(icn1) 리전에서 실행되어, 특정 축제(contentId)의 부가정보(이용요금·주최/주관·
// 홈페이지 등)를 공공데이터포털 TourAPI(detailIntro2)에서 대신 가져와주는 프록시 함수.

const BASE_URL = 'https://apis.data.go.kr/B551011/KorService2/detailIntro2';

export default async function handler(req, res) {
  // festival/detail 상세페이지 생성용으로 GitHub Actions(Python)에서만 호출하지만,
  // 혹시 클라이언트에서 직접 호출할 경우를 대비해 CORS도 허용해둔다.
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = process.env.TOUR_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'TOUR_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  const contentId = req.query.contentId;
  if (!contentId) {
    res.status(400).json({ error: 'contentId 쿼리 파라미터가 필요합니다.' });
    return;
  }

  // detailIntro2는 detailCommon2와 달리 콘텐츠 타입마다 반환 필드 구성 자체가 달라지는
  // API라(예: 숙박이면 체크인시간, 축제면 이용요금) contentTypeId가 여전히 필요할 가능성이
  // 높다고 보고 우선 포함한다. 만약 이 값 때문에 오류가 나면(detailCommon2 때처럼
  // INVALID_REQUEST_PARAMETER_ERROR) 이 파라미터를 빼는 쪽으로 다시 수정하면 된다.
  const contentTypeId = req.query.contentTypeId || '15';

  const url = new URL(BASE_URL);
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('MobileOS', 'ETC');
  url.searchParams.set('MobileApp', 'hohoplay');
  url.searchParams.set('_type', 'json');
  url.searchParams.set('contentId', contentId);
  url.searchParams.set('contentTypeId', contentTypeId);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`TourAPI HTTP ${response.status} | ${bodyText.slice(0, 200)}`);
    }

    const data = await response.json();
    const header = data?.response?.header;
    if (!header || (header.resultCode !== '0000' && header.resultCode !== '00')) {
      throw new Error(`TourAPI 오류 응답: ${header?.resultMsg || JSON.stringify(data).slice(0, 300)}`);
    }

    const body = data?.response?.body;
    const items = body?.items;
    let item = null;
    if (items && items !== '') {
      item = Array.isArray(items.item) ? items.item[0] : items.item;
    }

    // 축제(contentTypeId=15) 기준 필드만 추려서 반환.
    res.status(200).json({
      sponsor1: item?.sponsor1 || '',
      sponsor1tel: item?.sponsor1tel || '',
      sponsor2: item?.sponsor2 || '',
      sponsor2tel: item?.sponsor2tel || '',
      eventplace: item?.eventplace || '',
      playtime: item?.playtime || '',
      usetimefestival: item?.usetimefestival || '',
      program: item?.program || '',
      spendtimefestival: item?.spendtimefestival || '',
      agelimit: item?.agelimit || '',
      bookingplace: item?.bookingplace || '',
      discountinfofestival: item?.discountinfofestival || '',
      placeinfo: item?.placeinfo || '',
      eventhomepage: item?.eventhomepage || ''
    });
  } catch (err) {
    console.error(`intro.js 오류 (contentId=${contentId}):`, err && err.message ? err.message : err);
    res.status(502).json({ error: String(err && err.message ? err.message : err) });
  }
}
