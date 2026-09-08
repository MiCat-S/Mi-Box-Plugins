const cities: Record<string, string> = {北京:"Beijing",上海:"Shanghai",广州:"Guangzhou",深圳:"Shenzhen",成都:"Chengdu",杭州:"Hangzhou",武汉:"Wuhan",西安:"Xi'an",重庆:"Chongqing",南京:"Nanjing",天津:"Tianjin",苏州:"Suzhou",长沙:"Changsha",郑州:"Zhengzhou",青岛:"Qingdao",大连:"Dalian",厦门:"Xiamen",香港:"Hong Kong",澳门:"Macau",台北:"Taipei",东京:"Tokyo",大阪:"Osaka",京都:"Kyoto",首尔:"Seoul",曼谷:"Bangkok",新加坡:"Singapore",吉隆坡:"Kuala Lumpur",雅加达:"Jakarta",伦敦:"London",巴黎:"Paris",柏林:"Berlin",罗马:"Rome",纽约:"New York",洛杉矶:"Los Angeles",旧金山:"San Francisco",芝加哥:"Chicago",多伦多:"Toronto",悉尼:"Sydney",墨尔本:"Melbourne"};

export const weatherCity = (name: string) => cities[name.trim()] || name.trim();

const icons: Record<number, string> = {0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 48: "🌫️", 51: "🌦️", 53: "🌦️", 55: "🌧️", 56: "🌨️", 57: "🌨️", 61: "🌧️", 63: "🌧️", 65: "🌧️", 66: "🌨️", 67: "🌨️", 71: "❄️", 73: "❄️", 75: "❄️", 77: "🌨️", 80: "🌦️", 81: "🌧️", 82: "⛈️", 85: "🌨️", 86: "🌨️", 95: "⛈️", 96: "⛈️", 99: "⛈️"};
export const weatherEmoji = (code: number) => icons[code] || "🌤️";
