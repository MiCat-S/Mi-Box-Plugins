type TextStyleMode = "normal" | "italic" | "double" | "sans" | "mono" | "outline";
type SeasonalAbbreviation = {standard: string; daylight: string};

export class NameAppearance {
  private readonly timezoneAbbreviationMap: Record<string, string> = {
    'Africa/Abidjan': 'GMT', 'Africa/Accra': 'GMT', 'Africa/Addis_Ababa': 'EAT', 'Africa/Algiers': 'CET',
    'Africa/Asmara': 'EAT', 'Africa/Bamako': 'GMT', 'Africa/Bangui': 'WAT', 'Africa/Banjul': 'GMT',
    'Africa/Bissau': 'GMT', 'Africa/Blantyre': 'CAT', 'Africa/Brazzaville': 'WAT', 'Africa/Cairo': 'EET',
    'Africa/Casablanca': 'WET', 'Africa/Ceuta': 'CET', 'Africa/Dakar': 'GMT', 'Africa/Dar_es_Salaam': 'EAT',
    'Africa/Djibouti': 'EAT', 'Africa/Douala': 'WAT', 'Africa/El_Aaiun': 'WET', 'Africa/Freetown': 'GMT',
    'Africa/Gaborone': 'CAT', 'Africa/Harare': 'CAT', 'Africa/Johannesburg': 'SAST', 'Africa/Juba': 'CAT',
    'Africa/Kampala': 'EAT', 'Africa/Khartoum': 'CAT', 'Africa/Kigali': 'CAT', 'Africa/Kinshasa': 'WAT',
    'Africa/Lagos': 'WAT', 'Africa/Libreville': 'WAT', 'Africa/Lome': 'GMT', 'Africa/Luanda': 'WAT',
    'Africa/Lubumbashi': 'CAT', 'Africa/Lusaka': 'CAT', 'Africa/Malabo': 'WAT', 'Africa/Maputo': 'CAT',
    'Africa/Maseru': 'SAST', 'Africa/Mbabane': 'SAST', 'Africa/Mogadishu': 'EAT', 'Africa/Monrovia': 'GMT',
    'Africa/Nairobi': 'EAT', 'Africa/Ndjamena': 'WAT', 'Africa/Niamey': 'WAT', 'Africa/Nouakchott': 'GMT',
    'Africa/Ouagadougou': 'GMT', 'Africa/Porto-Novo': 'WAT', 'Africa/Sao_Tome': 'GMT', 'Africa/Tripoli': 'EET',
    'Africa/Tunis': 'CET', 'Africa/Windhoek': 'CAT', 'America/Adak': 'HST', 'America/Anchorage': 'AKST',
    'America/Anguilla': 'AST', 'America/Antigua': 'AST', 'America/Araguaina': 'BRT', 'America/Argentina/Buenos_Aires': 'ART',
    'America/Argentina/Catamarca': 'ART', 'America/Argentina/Cordoba': 'ART', 'America/Argentina/Mendoza': 'ART',
    'America/Aruba': 'AST', 'America/Asuncion': 'PYT', 'America/Atikokan': 'EST', 'America/Bahia': 'BRT',
    'America/Bahia_Banderas': 'CST', 'America/Barbados': 'AST', 'America/Belem': 'BRT', 'America/Belize': 'CST',
    'America/Blanc-Sablon': 'AST', 'America/Boa_Vista': 'AMT', 'America/Bogota': 'COT', 'America/Boise': 'MST',
    'America/Cambridge_Bay': 'MST', 'America/Campo_Grande': 'AMT', 'America/Cancun': 'EST', 'America/Caracas': 'VET',
    'America/Cayenne': 'GFT', 'America/Cayman': 'EST', 'America/Chicago': 'CST', 'America/Chihuahua': 'MST',
    'America/Ciudad_Juarez': 'MST', 'America/Costa_Rica': 'CST', 'America/Creston': 'MST', 'America/Cuiaba': 'AMT',
    'America/Curacao': 'AST', 'America/Danmarkshavn': 'GMT', 'America/Dawson': 'MST', 'America/Dawson_Creek': 'MST',
    'America/Denver': 'MST', 'America/Detroit': 'EST', 'America/Dominica': 'AST', 'America/Edmonton': 'MST',
    'America/Eirunepe': 'ACT', 'America/El_Salvador': 'CST', 'America/Fort_Nelson': 'MST', 'America/Fortaleza': 'BRT',
    'America/Glace_Bay': 'AST', 'America/Goose_Bay': 'AST', 'America/Grand_Turk': 'EST', 'America/Guatemala': 'CST',
    'America/Guayaquil': 'ECT', 'America/Guyana': 'GYT', 'America/Halifax': 'AST', 'America/Havana': 'CST',
    'America/Hermosillo': 'MST', 'America/Indiana/Indianapolis': 'EST', 'America/Indiana/Knox': 'CST',
    'America/Indiana/Marengo': 'EST', 'America/Indiana/Petersburg': 'EST', 'America/Indiana/Tell_City': 'CST',
    'America/Indiana/Vevay': 'EST', 'America/Indiana/Vincennes': 'EST', 'America/Indiana/Winamac': 'EST',
    'America/Inuvik': 'MST', 'America/Iqaluit': 'EST', 'America/Jamaica': 'EST', 'America/Juneau': 'AKST',
    'America/Kentucky/Louisville': 'EST', 'America/Kentucky/Monticello': 'EST', 'America/Kralendijk': 'AST',
    'America/La_Paz': 'BOT', 'America/Lima': 'PET', 'America/Los_Angeles': 'PST', 'America/Maceio': 'BRT',
    'America/Managua': 'CST', 'America/Manaus': 'AMT', 'America/Martinique': 'AST', 'America/Matamoros': 'CST',
    'America/Mazatlan': 'MST', 'America/Menominee': 'CST', 'America/Merida': 'CST', 'America/Metlakatla': 'AKST',
    'America/Mexico_City': 'CST', 'America/Miquelon': 'PMST', 'America/Moncton': 'AST', 'America/Monterrey': 'CST',
    'America/Montevideo': 'UYT', 'America/Nassau': 'EST', 'America/New_York': 'EST', 'America/Nipigon': 'EST',
    'America/Nome': 'AKST', 'America/Noronha': 'FNT', 'America/North_Dakota/Beulah': 'CST', 'America/North_Dakota/Center': 'CST',
    'America/North_Dakota/New_Salem': 'CST', 'America/Nuuk': 'WGT', 'America/Ojinaga': 'CST', 'America/Panama': 'EST',
    'America/Paramaribo': 'SRT', 'America/Phoenix': 'MST', 'America/Port_of_Spain': 'AST', 'America/Port-au-Prince': 'EST',
    'America/Porto_Velho': 'AMT', 'America/Puerto_Rico': 'AST', 'America/Punta_Arenas': 'CLT', 'America/Rainy_River': 'CST',
    'America/Rankin_Inlet': 'CST', 'America/Recife': 'BRT', 'America/Regina': 'CST', 'America/Resolute': 'CST',
    'America/Rio_Branco': 'ACT', 'America/Santarem': 'BRT', 'America/Santiago': 'CLT', 'America/Santo_Domingo': 'AST',
    'America/Sao_Paulo': 'BRT', 'America/Scoresbysund': 'EGT', 'America/Sitka': 'AKST', 'America/St_Johns': 'NST',
    'America/Swift_Current': 'CST', 'America/Tegucigalpa': 'CST', 'America/Thule': 'AST', 'America/Thunder_Bay': 'EST',
    'America/Tijuana': 'PST', 'America/Toronto': 'EST', 'America/Tortola': 'AST', 'America/Vancouver': 'PST',
    'America/Whitehorse': 'MST', 'America/Winnipeg': 'CST', 'America/Yakutat': 'AKST', 'America/Yellowknife': 'MST',
    'Antarctica/Casey': 'AWST', 'Antarctica/Davis': 'DAVT', 'Antarctica/DumontDUrville': 'DDUT', 'Antarctica/Macquarie': 'AEST',
    'Antarctica/Mawson': 'MAWT', 'Antarctica/McMurdo': 'NZST', 'Antarctica/Palmer': 'CLT', 'Antarctica/Rothera': 'ROT',
    'Antarctica/South_Pole': 'NZST', 'Antarctica/Syowa': 'SYOT', 'Antarctica/Troll': 'UTC', 'Antarctica/Vostok': 'VOST',
    'Asia/Aden': 'AST', 'Asia/Almaty': 'ALMT', 'Asia/Amman': 'EET', 'Asia/Anadyr': 'ANAT', 'Asia/Aqtau': 'AQTT',
    'Asia/Aqtobe': 'AQTT', 'Asia/Ashgabat': 'TMT', 'Asia/Atyrau': 'AQTT', 'Asia/Baghdad': 'AST', 'Asia/Bahrain': 'AST',
    'Asia/Baku': 'AZT', 'Asia/Bangkok': 'ICT', 'Asia/Barnaul': 'KRAT', 'Asia/Beirut': 'EET', 'Asia/Bishkek': 'KGT',
    'Asia/Brunei': 'BNT', 'Asia/Calcutta': 'IST', 'Asia/Chita': 'YAKT', 'Asia/Choibalsan': 'CHOT', 'Asia/Chongqing': 'CST',
    'Asia/Colombo': 'IST', 'Asia/Damascus': 'EET', 'Asia/Dhaka': 'BDT', 'Asia/Dili': 'TLT', 'Asia/Dubai': 'GST',
    'Asia/Dushanbe': 'TJT', 'Asia/Famagusta': 'EET', 'Asia/Gaza': 'EET', 'Asia/Harbin': 'CST', 'Asia/Hebron': 'EET',
    'Asia/Ho_Chi_Minh': 'ICT', 'Asia/Hong_Kong': 'HKT', 'Asia/Hovd': 'HOVT', 'Asia/Irkutsk': 'IRKT', 'Asia/Istanbul': 'TRT',
    'Asia/Jakarta': 'WIB', 'Asia/Jayapura': 'WIT', 'Asia/Jerusalem': 'IST', 'Asia/Kabul': 'AFT', 'Asia/Kamchatka': 'PETT',
    'Asia/Karachi': 'PKT', 'Asia/Kashgar': 'XJT', 'Asia/Kathmandu': 'NPT', 'Asia/Khandyga': 'YAKT', 'Asia/Kolkata': 'IST',
    'Asia/Krasnoyarsk': 'KRAT', 'Asia/Kuala_Lumpur': 'MYT', 'Asia/Kuching': 'MYT', 'Asia/Kuwait': 'AST', 'Asia/Macao': 'CST',
    'Asia/Magadan': 'MAGT', 'Asia/Makassar': 'WITA', 'Asia/Manila': 'PST', 'Asia/Muscat': 'GST', 'Asia/Nicosia': 'EET',
    'Asia/Novokuznetsk': 'KRAT', 'Asia/Novosibirsk': 'NOVT', 'Asia/Omsk': 'OMST', 'Asia/Oral': 'ORAT', 'Asia/Phnom_Penh': 'ICT',
    'Asia/Pontianak': 'WIB', 'Asia/Pyongyang': 'KST', 'Asia/Qatar': 'AST', 'Asia/Qostanay': 'QYZT', 'Asia/Qyzylorda': 'QYZT',
    'Asia/Rangoon': 'MMT', 'Asia/Riyadh': 'AST', 'Asia/Sakhalin': 'SAKT', 'Asia/Samarkand': 'UZT', 'Asia/Seoul': 'KST',
    'Asia/Shanghai': 'CST', 'Asia/Singapore': 'SGT', 'Asia/Srednekolymsk': 'SRET', 'Asia/Taipei': 'CST', 'Asia/Tashkent': 'UZT',
    'Asia/Tbilisi': 'GET', 'Asia/Tehran': 'IRST', 'Asia/Tel_Aviv': 'IST', 'Asia/Thimphu': 'BTT', 'Asia/Tokyo': 'JST',
    'Asia/Tomsk': 'TOMT', 'Asia/Ulaanbaatar': 'ULAT', 'Asia/Urumqi': 'XJT', 'Asia/Ust-Nera': 'VLAT', 'Asia/Vientiane': 'ICT',
    'Asia/Vladivostok': 'VLAT', 'Asia/Yakutsk': 'YAKT', 'Asia/Yangon': 'MMT', 'Asia/Yekaterinburg': 'YEKT', 'Asia/Yerevan': 'AMT',
    'Atlantic/Azores': 'AZOT', 'Atlantic/Bermuda': 'AST', 'Atlantic/Canary': 'WET', 'Atlantic/Cape_Verde': 'CVT',
    'Atlantic/Faeroe': 'WET', 'Atlantic/Faroe': 'WET', 'Atlantic/Jan_Mayen': 'CET', 'Atlantic/Madeira': 'WET',
    'Atlantic/Reykjavik': 'GMT', 'Atlantic/South_Georgia': 'GST', 'Atlantic/St_Helena': 'GMT', 'Atlantic/Stanley': 'FKST',
    'Arctic/Longyearbyen': 'CET', 'Australia/ACT': 'AEST', 'Australia/Adelaide': 'ACST', 'Australia/Brisbane': 'AEST',
    'Australia/Broken_Hill': 'ACST', 'Australia/Canberra': 'AEST', 'Australia/Currie': 'AEST', 'Australia/Darwin': 'ACST',
    'Australia/Eucla': 'ACWST', 'Australia/Hobart': 'AEST', 'Australia/LHI': 'LHST', 'Australia/Lindeman': 'AEST',
    'Australia/Lord_Howe': 'LHST', 'Australia/Melbourne': 'AEST', 'Australia/North': 'ACST', 'Australia/NSW': 'AEST',
    'Australia/Perth': 'AWST', 'Australia/Queensland': 'AEST', 'Australia/South': 'ACST', 'Australia/Sydney': 'AEST',
    'Australia/Tasmania': 'AEST', 'Australia/Victoria': 'AEST', 'Australia/West': 'AWST', 'Australia/Yancowinna': 'ACST',
    'Europe/Andorra': 'CET', 'Europe/Astrakhan': 'SAMT', 'Europe/Athens': 'EET', 'Europe/Belgrade': 'CET',
    'Europe/Berlin': 'CET', 'Europe/Brussels': 'CET', 'Europe/Bucharest': 'EET', 'Europe/Budapest': 'CET',
    'Europe/Chisinau': 'EET', 'Europe/Dublin': 'GMT', 'Europe/Gibraltar': 'CET', 'Europe/Helsinki': 'EET',
    'Europe/Istanbul': 'TRT', 'Europe/Kaliningrad': 'EET', 'Europe/Kirov': 'MSK', 'Europe/Kyiv': 'EET',
    'Europe/Lisbon': 'WET', 'Europe/London': 'GMT', 'Europe/Madrid': 'CET', 'Europe/Malta': 'CET',
    'Europe/Minsk': 'MSK', 'Europe/Moscow': 'MSK', 'Europe/Paris': 'CET', 'Europe/Prague': 'CET',
    'Europe/Riga': 'EET', 'Europe/Rome': 'CET', 'Europe/Samara': 'SAMT', 'Europe/Saratov': 'SAMT',
    'Europe/Simferopol': 'MSK', 'Europe/Sofia': 'EET', 'Europe/Tallinn': 'EET', 'Europe/Tirane': 'CET',
    'Europe/Ulyanovsk': 'SAMT', 'Europe/Vienna': 'CET', 'Europe/Vilnius': 'EET', 'Europe/Volgograd': 'MSK',
    'Europe/Warsaw': 'CET', 'Europe/Zurich': 'CET', 'Indian/Chagos': 'IOT', 'Indian/Christmas': 'CXT',
    'Indian/Cocos': 'CCT', 'Indian/Kerguelen': 'TFT', 'Indian/Maldives': 'MVT', 'Indian/Mauritius': 'MUT',
    'Indian/Mayotte': 'EAT', 'Indian/Reunion': 'RET', 'Pacific/Apia': 'WST', 'Pacific/Auckland': 'NZST',
    'Pacific/Bougainville': 'BST', 'Pacific/Chatham': 'CHAST', 'Pacific/Easter': 'EASST', 'Pacific/Efate': 'VUT',
    'Pacific/Fakaofo': 'TKT', 'Pacific/Fiji': 'FJT', 'Pacific/Galapagos': 'GALT', 'Pacific/Gambier': 'GAMT',
    'Pacific/Guadalcanal': 'SBT', 'Pacific/Guam': 'ChST', 'Pacific/Honolulu': 'HST', 'Pacific/Kanton': 'PHOT',
    'Pacific/Kiritimati': 'LINT', 'Pacific/Kosrae': 'KOST', 'Pacific/Kwajalein': 'MHT', 'Pacific/Marquesas': 'MART',
    'Pacific/Nauru': 'NRT', 'Pacific/Niue': 'NUT', 'Pacific/Norfolk': 'NFT', 'Pacific/Noumea': 'NCT',
    'Pacific/Pago_Pago': 'SST', 'Pacific/Palau': 'PWT', 'Pacific/Pitcairn': 'PST', 'Pacific/Port_Moresby': 'PGT',
    'Pacific/Rarotonga': 'CKT', 'Pacific/Tahiti': 'TAHT', 'Pacific/Tarawa': 'GILT', 'Pacific/Tongatapu': 'TOT',
    'Pacific/Wake': 'WAKT', 'Pacific/Wallis': 'WFT', 'UTC': 'UTC', 'Etc/UTC': 'UTC', 'Etc/GMT': 'GMT'
  };

  private readonly offsetAbbreviationFallbacks: Record<string, string> = {
    '+00:00': 'GMT', '+01:00': 'CET', '+02:00': 'EET', '+03:00': 'MSK', '+04:00': 'GST',
    '+05:00': 'PKT', '+05:30': 'IST', '+05:45': 'NPT', '+06:00': 'BST', '+06:30': 'MMT',
    '+07:00': 'ICT', '+08:00': 'CST', '+08:45': 'ACWST', '+09:00': 'JST', '+09:30': 'ACST',
    '+10:00': 'AEST', '+10:30': 'LHST', '+11:00': 'AEDT', '+12:00': 'NZST', '+13:00': 'NZDT',
    '+14:00': 'LINT', '-01:00': 'AZOT', '-02:00': 'GST', '-03:00': 'ART', '-03:30': 'NST',
    '-04:00': 'AST', '-05:00': 'EST', '-06:00': 'CST', '-07:00': 'MST', '-08:00': 'PST',
    '-09:00': 'AKST', '-10:00': 'HST', '-11:00': 'SST', '-12:00': 'AoE'
  };

  private readonly seasonalTimezoneAbbreviationMap: Record<string, SeasonalAbbreviation> = {
    'America/Anchorage': { standard: 'AKST', daylight: 'AKDT' },
    'America/Chicago': { standard: 'CST', daylight: 'CDT' },
    'America/Denver': { standard: 'MST', daylight: 'MDT' },
    'America/Detroit': { standard: 'EST', daylight: 'EDT' },
    'America/Halifax': { standard: 'AST', daylight: 'ADT' },
    'America/Los_Angeles': { standard: 'PST', daylight: 'PDT' },
    'America/New_York': { standard: 'EST', daylight: 'EDT' },
    'America/Santiago': { standard: 'CLT', daylight: 'CLST' },
    'America/St_Johns': { standard: 'NST', daylight: 'NDT' },
    'America/Toronto': { standard: 'EST', daylight: 'EDT' },
    'America/Vancouver': { standard: 'PST', daylight: 'PDT' },
    'America/Winnipeg': { standard: 'CST', daylight: 'CDT' },
    'Atlantic/Azores': { standard: 'AZOT', daylight: 'AZOST' },
    'Atlantic/Bermuda': { standard: 'AST', daylight: 'ADT' },
    'Australia/Adelaide': { standard: 'ACST', daylight: 'ACDT' },
    'Australia/Hobart': { standard: 'AEST', daylight: 'AEDT' },
    'Australia/Melbourne': { standard: 'AEST', daylight: 'AEDT' },
    'Australia/Sydney': { standard: 'AEST', daylight: 'AEDT' },
    'Europe/Athens': { standard: 'EET', daylight: 'EEST' },
    'Europe/Berlin': { standard: 'CET', daylight: 'CEST' },
    'Europe/Brussels': { standard: 'CET', daylight: 'CEST' },
    'Europe/Dublin': { standard: 'GMT', daylight: 'IST' },
    'Europe/Helsinki': { standard: 'EET', daylight: 'EEST' },
    'Europe/Lisbon': { standard: 'WET', daylight: 'WEST' },
    'Europe/London': { standard: 'GMT', daylight: 'BST' },
    'Europe/Madrid': { standard: 'CET', daylight: 'CEST' },
    'Europe/Paris': { standard: 'CET', daylight: 'CEST' },
    'Europe/Prague': { standard: 'CET', daylight: 'CEST' },
    'Europe/Rome': { standard: 'CET', daylight: 'CEST' },
    'Europe/Vienna': { standard: 'CET', daylight: 'CEST' },
    'Europe/Warsaw': { standard: 'CET', daylight: 'CEST' },
    'Europe/Zurich': { standard: 'CET', daylight: 'CEST' },
    'Pacific/Auckland': { standard: 'NZST', daylight: 'NZDT' },
    'Pacific/Chatham': { standard: 'CHAST', daylight: 'CHADT' }
  };

  private getOffsetKey(sign: string, hours: number, minutes: number): string {
    return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }

  private getIntlTimezoneAbbreviation(timezone: string): string | null {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short'
      }).formatToParts(new Date());

      const abbreviation = parts.find(part => part.type === 'timeZoneName')?.value?.trim();
      if (!abbreviation) return null;
      if (/^GMT[+-]/.test(abbreviation)) return null;
      return abbreviation;
    } catch {
      return null;
    }
  }

  private getOffsetMinutesForDate(timezone: string, date: Date): number | null {
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        timeZoneName: 'longOffset'
      }).formatToParts(date);

      const offsetPart = parts.find(part => part.type === 'timeZoneName')?.value;
      if (!offsetPart) return null;
      if (offsetPart === "GMT") return 0;

      const match = offsetPart.match(/GMT([+-])(\d{2}):(\d{2})/);
      if (!match) return null;

      const sign = match[1] === '+' ? 1 : -1;
      const hours = parseInt(match[2], 10);
      const minutes = parseInt(match[3], 10);
      return sign * (hours * 60 + minutes);
    } catch {
      return null;
    }
  }

  private getSeasonalTimezoneAbbreviation(timezone: string): string | null {
    const abbreviations = this.seasonalTimezoneAbbreviationMap[timezone];
    if (!abbreviations) return null;

    const now = new Date();
    const year = now.getUTCFullYear();
    const januaryOffset = this.getOffsetMinutesForDate(timezone, new Date(Date.UTC(year, 0, 1, 12, 0, 0)));
    const julyOffset = this.getOffsetMinutesForDate(timezone, new Date(Date.UTC(year, 6, 1, 12, 0, 0)));
    const currentOffset = this.getOffsetMinutesForDate(timezone, now);

    if (januaryOffset === null || julyOffset === null || currentOffset === null || januaryOffset === julyOffset) {
      return null;
    }

    const daylightOffset = Math.max(januaryOffset, julyOffset);
    return currentOffset === daylightOffset ? abbreviations.daylight : abbreviations.standard;
  }

  private getTimezoneAbbreviation(timezone: string, sign: string, hours: number, minutes: number): string {
    const intlAbbreviation = this.getIntlTimezoneAbbreviation(timezone);
    if (intlAbbreviation) return intlAbbreviation;

    const seasonalAbbreviation = this.getSeasonalTimezoneAbbreviation(timezone);
    if (seasonalAbbreviation) return seasonalAbbreviation;

    const exact = this.timezoneAbbreviationMap[timezone];
    if (exact) return exact;

    const offsetKey = this.getOffsetKey(sign, hours, minutes);
    return this.offsetAbbreviationFallbacks[offsetKey] || `GMT${offsetKey}`;
  }

  private getDoubleStruckUpper(char: string): string {
    const map: Record<string, string> = {
      A: '𝔸', B: '𝔹', C: 'ℂ', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', H: 'ℍ', I: '𝕀', J: '𝕁',
      K: '𝕂', L: '𝕃', M: '𝕄', N: 'ℕ', O: '𝕆', P: 'ℙ', Q: 'ℚ', R: 'ℝ', S: '𝕊', T: '𝕋',
      U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐', Z: 'ℤ'
    };
    return map[char] || char;
  }

  private stylizeChar(char: string, style: TextStyleMode): string {
    if (style === "normal") return char;

    const code = char.codePointAt(0);
    if (code === undefined) return char;

    if (style === "italic") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7CE + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x1D400 + (code - 0x41));
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D41A + (code - 0x61));
      return char;
    }

    if (style === "double") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7D8 + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return this.getDoubleStruckUpper(char);
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D552 + (code - 0x61));
      return char;
    }

    if (style === "sans") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7EC + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x1D5D4 + (code - 0x41));
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D5EE + (code - 0x61));
      return char;
    }

    if (style === "mono") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7F6 + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x1D670 + (code - 0x41));
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D68A + (code - 0x61));
      return char;
    }

    if (style === "outline") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7E2 + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x1D5A0 + (code - 0x41));
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D5BA + (code - 0x61));
      return char;
    }

    return char;
  }

  applyTextStyle(text: string, style?: TextStyleMode): string {
    const finalStyle = style || "normal";
    if (finalStyle === "normal" || !text) return text;
    return Array.from(text).map(char => this.stylizeChar(char, finalStyle)).join("");
  }
  timezoneLabel(timezone: string, format = "GMT"): string {
    if (format.toLowerCase().startsWith("custom:")) return format.slice(7);
    const offset = new Intl.DateTimeFormat("en", {timeZone: timezone, timeZoneName: "longOffset"})
      .formatToParts(new Date()).find(part => part.type === "timeZoneName")!.value;
    const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
    const sign = match?.[1] || "+", hours = Number(match?.[2] || 0), minutes = Number(match?.[3] || 0);
    switch (format.toUpperCase()) {
      case "SIMP": return this.getTimezoneAbbreviation(timezone, sign, hours, minutes);
      case "OFFSET": return this.getOffsetKey(sign, hours, minutes);
      case "UTC": return hours || minutes ? minutes ? offset.replace("GMT", "UTC") : `UTC${sign}${hours}` : "UTC";
      default: return hours || minutes ? offset.replace(/([+-])0(\d):00$/, "$1$2").replace(/:00$/, "") : "GMT";
    }
  }
}
