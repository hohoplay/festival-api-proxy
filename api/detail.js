// 서울(icn1) 리전에서 실행되어, 특정 축제(contentId)의 상세 설명(overview)을
// 공공데이터포털 TourAPI(detailCommon2)에서 대신 가져와주는 프록시 함수.

const BASE_URL = 'https://apis.data.go.kr/B551011/KorService2/detailCommon2';

export default async function handler(req, res) {
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

  const url = new URL(BASE_URL);
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('contentId', contentId);
  url.searchParams.set('contentTypeId', '15'); // 15 = 행사/공연/축제
  url.searchParams.set('MobileOS', 'ETC');
  url.searchParams.set('MobileApp', 'hohoplay');
  url.searchParams.set('_type', 'json');
  url.searchParams.set('defaultYN', 'Y');
  url.searchParams.set('overviewYN', 'Y');

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

    res.status(200).json({ overview: item?.overview || '' });
  } catch (err) {
    res.status(502).json({ error: String(err && err.message ? err.message : err) });
  }
}
