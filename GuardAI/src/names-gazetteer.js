/**
 * GuardAI — names-gazetteer.js
 * ---------------------------------------------------------------------------
 * Given names and surnames used ONLY by the opt-in "Aggressive name detection"
 * mode. The default rule (a full name alongside other PII) is shape-based and
 * does not consult this file at all.
 *
 * ═══ WHAT THIS LIST ACTUALLY IS ═══════════════════════════════════════════
 *
 * HAND-BUILT TO DEMOGRAPHIC QUOTAS. NOT FREQUENCY-RANKED.
 *
 * There is no census extract, no name-frequency dataset and no licensed
 * corpus behind this file. It was written to deliberate per-origin quotas
 * reflecting Australian demographics, because an unguided list skews heavily
 * Anglo — and in this detector a missing given name is not a neutral gap: an
 * ambiguous first name only escapes the stoplist when the list vouches for
 * it, so under-covering a community means systematically weaker protection
 * for the people in it.
 *
 * Consequences to keep in mind:
 *   - Ordering WITHIN each group is not frequency-ranked. Coverage of the
 *     long tail is unmeasured and certainly patchy.
 *   - Absence proves nothing. A name missing here is an artefact of how the
 *     list was written, never evidence that it isn't a real name.
 *   - Replacing this with a real frequency-ranked dataset would be a
 *     straight improvement. It was not done because that is a licensing
 *     decision, not a technical one.
 *
 * Approximate composition of the given-name list:
 *   Anglo-Celtic ~32%, Indian subcontinent ~12%, S/E European ~10%,
 *   Chinese ~9%, Arabic/Turkish/Persian ~9%, African ~7%,
 *   E/SE Asian ~6%, Vietnamese ~5%, Latin American ~5%, Filipino ~4%,
 *   Pacific/Māori ~3%, Aboriginal & Torres Strait Islander ~2%.
 *
 * ═══ STORAGE ═════════════════════════════════════════════════════════════
 * Space-delimited strings split into Sets at load: roughly 3 bytes per name
 * cheaper than an array literal, and one split() at content-script start.
 * Lookups are lowercase.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  // ---- Given names, partitioned by likely gender ----------------------
  //
  // The partition exists so a masked stand-in can keep the same gender: a
  // female name replaced by a male one makes the AI's reply subtly wrong
  // ("name is Sophie Newman" -> "Got it, Oliver").
  //
  // TAGGED CONSERVATIVELY, AND THAT IS THE POINT. Anything I was not
  // confident about is UNISEX, not guessed. Gender is culturally variable in
  // exactly the way this list is built to span — "juan" is a Spanish male
  // name and a Chinese female one, "andrea" is male in Italian and female in
  // English, "jean" flips between French and English. A wrong tag produces a
  // confidently wrong stand-in, which is worse than a neutral one, and it
  // would land hardest on the non-Anglo names the quotas exist to protect.
  // Unisex routes that uncertainty to a neutral stand-in instead.
  //
  // So UNISEX here means any of three things, and the code does not care
  // which: genuinely unisex, unknown to me, or contradictory across origins.
  // Most Chinese, Vietnamese and Korean romanisations sit here because
  // romanised form alone does not carry gender reliably.
  //
  // Detection is UNAFFECTED: isFirst() is the union of all three, so the
  // matcher sees exactly the same set of names as before this split.
  const FIRST_MALE = [
    "aarav aaron abdirahman abebe adam adebayo aditya agus ahmad ahmed ajay akash",
    "akira akol alejandro alessandro alexander alexandru alfie ali amir amit",
    "andrei andrew angelo angus anil ankit anthony antonio arash archie arjun",
    "arnel arthit arthur arun athanasios aziz babak babatunde bala baljit bao",
    "baris benicio benjamin bilal billy bogdan bol brandon brian bruce bruno",
    "bryan budi burak callum calum carl carlo carlos cem chalermchai chamara",
    "charles chidi chinedu christian christopher christos cian cormac cristian",
    "daniel david davide declan deepak deng dennis dexter diego dilshan dimitrios",
    "dinesh donald dorje douglas doyoon dragan duc dylan edgardo eduardo edward",
    "emeka emiliano emre eoin eric ethan farhad farhan federico ferdinand fergus",
    "fernando filipe finlay florin francesco freddie gabriel ganesh garang gary",
    "gaurav george georgios gerald getachew gheorghe giovanni giuseppe gopal",
    "gregory grzegorz guled guoqiang gurpreet habib hafiz hamish harold harpreet",
    "harry harsh haruto hassan hemi henry hieu hiroshi hossein hussein hyunwoo",
    "ibrahim ignacio ikenna imran ioannis ismail ivan jack jacob jakub james",
    "jamil jason jaspreet javier jeffrey jeremy jerry jesse jiahao jianguo",
    "jianhua joaquin joe john jomar jonathan jorge jose joseph joshua josip",
    "justin karan karim karthik kasun keith kenji kenneth kerem ketut keung",
    "khalid kofi konstantinos kourosh krishna krzysztof kwabena kwame kwok kyle",
    "lachlan lakmal larry lawrence leo liam logan long lorenzo luigi luis luka",
    "lukasz made mahesh mahmoud majok manish manpreet mansour marcin marco marko",
    "mateo mateusz matiu matteo matthew mehdi mehmet michael michal miguel mihai",
    "milan minjun mohammed mohan mohit muhammad mukesh mulugeta murali murat",
    "mustafa nabil najib nasir nathan nattapong naveen nicholas nicolas nikhil",
    "nikola nikolaos nitin nnamdi noah nuwan nyoman obinna oisin oliver olumide",
    "omar padraig panagiotis pankaj patrick paul pawel payam pemba petar peter",
    "phuc pietro piotr prakash praveen quan rafael rahim rahul rajan rajesh raman",
    "ramesh ramon rashid ravi razvan reynaldo reza ricardo riccardo richard",
    "robert rodel roger rohan rohit rolando romeo ronald ronan rory ruwan ryan",
    "sachin salman salvatore sameer sami samuel sanjay santiago scott seamus sean",
    "sebastian senthil seojun serkan shahrul siale siavash sicheng simone sione",
    "somchai somsak son sota stavros stefan stefano stephen steven struan suchart",
    "sukhwinder sumit sungmin sunil suresh syafiq tadesse tahir tak takeshi tama",
    "tane tariq tarun tenzin terry tevita theo thiago thomas thon timothy tolga",
    "tomasz tyler varun vasile vasilios vihaan vijay vikas viliami vincenzo wah",
    "wahid waleed warsame wayan wenjun wilfredo william wiremu yash yaw yohannes",
    "youssef yusuf zachary zhihua zhiqiang zoran zubin zulkifli",
  ].join(" ");

  const FIRST_FEMALE = [
    "abena abigail achol adaeze aditi afia agnieszka aisha akosua alessia alexis",
    "aluel ama amaka amanda amber amelia amina amira amirah amrit amy ana anahera",
    "ananya anastasia andrea angela angelica angeliki anita anjali anna aoi aoife",
    "aroha asha ashley ayaan ayse azadeh barbara bethlehem betty beverly brenda",
    "bridget brittany camila carmen carol carolyn catherine ceren charlotte",
    "cheryl chiamaka chiara chloe christina christine ciara consuelo corazon",
    "cristina cynthia dalia daniela danielle deborah debra denise despina dewi",
    "diane dilara dimitra divina divya dolores donna dorothy dragana eilidh elena",
    "eleni elif elizabeth emily emma esi esperanza esra eunji evelyn ewa fang",
    "farhia farida faridah fatima fatma fiona folake francesca gabriela georgia",
    "gita giulia gloria golnaz grace hala hanna hannah heather helen hine hodan",
    "hong huda huong ifeoma iman imelda inmaculada isabella isha ishara isla",
    "ivana jacqueline jane janet janice jasmine jelena jennifer jennylyn jessica",
    "jihye joan joanna joyce judith judy julia julie jyoti kanya karen katarzyna",
    "katerina katherine kathleen kathryn kavita kavya kelly kimberly kiri lakshmi",
    "laleh lan laura lauren layla leila lhamo liadh linda ling lisa lori lourdes",
    "lucia lupe madison maeve magdalena mai mairi mala malak malgorzata malia",
    "manaia margaret maria mariana marie marija marilyn martha martina mary",
    "maryam megan megha mei melissa mercedes mere merve meseret michelle minseo",
    "mirjana mitra montserrat nadeesha nadia namrata nancy nasra nasrin natalia",
    "natalie natasa navjot neha ngoc ngozi nhung niamh nicole noor nurul nyandeng",
    "ofa olivia orla pamela parisa parvati patricia paula pilar pinar pooja poppy",
    "pornthip preeti priya putri qin rachel radha rania rebecca rekha rina ritu",
    "riya rocio roisin rosario rose rosnah roya ruby rupinder ruth sabrina sakura",
    "salma samantha samira sanaz sandra sanduni sanja saoirse sara sarah",
    "saraswati selamawit selin shalini sharon shirin shirley shreya silvia simran",
    "sina sinead siobhan siriporn sita sneha snezana sofia soledad sophia sophie",
    "soyeon sri stephanie sunita susan swati teresa thao theresa thilini tigist",
    "trang tupou usha vaea valentina vasiliki vesna victoria virginia wanida xia",
    "yasmin yewande yui yun zahra zainab zeynep zhen zoe zofia",
  ].join(" ");

  const FIRST_UNISEX = [
    "adelaide ajak alexandria alinta allira angel anh april ariki art august",
    "austin autumn bill bin bindi birrani brook brooke brooklyn buck bud carolina",
    "chase chau chelsea chen chi ching chip chun clay cleveland cliff colt",
    "crystal daisy dakota dale dawa dawn dean drew duke dung earl eden eumarrah",
    "faith farah feng florence ford frank fung gang gene giang glen guy hamilton",
    "hanh haoyu harmony hazel heath hei hoang hoi hope hua hui hunter india iris",
    "ivy jackson jade jarrah jedda jie jing jiwoo jordan joy juan jun june",
    "justice ka kalinda karma kauri kayla kelechi kent khanh khoa king kingston",
    "kiran kirra kirrily kit koori lagi lane lei li lily lincoln linh lok lowanna",
    "man mark may melody miles miminy ming minh moana montana moss nana narelle",
    "ngaio nguyen nima noel olive oluwaseun paris pasang pearl penny phoenix",
    "phuong ping prince qiang quyen rain rangi reed rich richmond rob royal ruoxi",
    "sage savannah serenity shun sierra siu sky sonam star storm summer sunny",
    "sydney tafili talia tao tarni tashi temitope thanh tianyi tran trinity tuan",
    "uchenna van wade walter wandjina warrin waru washington wei will wing",
    "xiaohong xiaoli xiaoming xin yan yang yee yichen yindi yiran yu yuen yuhan",
    "yuki yuxuan zixuan ziyi",
  ].join(" ");

  // ---- Surnames -----------------------------------------------------------
  const LAST = [
    // Anglo-Celtic
    "smith jones williams brown taylor davies wilson evans thomas johnson",
    "roberts walker wright robinson thompson white hughes edwards green lewis",
    "wood harris martin jackson clarke clark turner hill moore cooper",
    "morris ward king watson baker morgan james bennett phillips davis",
    "mitchell kelly bailey murphy price shaw butler russell barnes fisher",
    "collins bell gray hunter palmer holmes marshall knight richardson stewart",
    "graham murray simpson ellis parker cook carter howard reid lee",
    "campbell young allen scott ross duncan macleod mackenzie fraser cameron",
    "sullivan oconnor obrien ryan doyle byrne kennedy walsh mcarthy gallagher",
    "whitfield ashcroft pemberton hargreaves fairweather kingsley waverley thornton lockwood ravenscroft",
    // Chinese
    "wang li zhang liu chen yang huang zhao wu zhou",
    "xu sun ma zhu hu guo he gao lin luo",
    "zheng liang xie song tang deng han feng cao peng",
    "chan cheung lam wong ho leung ng chow yip tsang",
    // Indian subcontinent
    "patel singh kumar sharma gupta verma mehta shah joshi desai",
    "reddy rao naidu iyer nair menon pillai krishnan raman subramaniam",
    "chatterjee banerjee mukherjee ghosh das bose sen dutta roy sarkar",
    "kaur gill dhillon sandhu bajwa grewal chahal sekhon randhawa mann",
    "fernando perera silva jayawardena wickramasinghe bandara rajapaksa gunawardena dissanayake ratnayake",
    "shrestha thapa gurung magar tamang rai limbu adhikari karki bhattarai",
    // Arabic, Turkish, Persian
    "khan ahmed ali hassan hussein ibrahim mahmoud abdullah rahman haddad",
    "farah nasser saleh mansour zaher jaber kassem darwish sayegh haidar",
    "yilmaz kaya demir sahin celik yildiz yildirim ozturk aydin arslan",
    "hosseini mohammadi rezaei ahmadi karimi moradi jafari sadeghi kazemi rahimi",
    // Southern and Eastern European
    "rossi russo ferrari esposito bianchi romano colombo ricci marino greco",
    "conti costa giordano rizzo lombardi moretti barbieri fontana caruso mariani",
    "papadopoulos nikolaidis georgiou vasileiou ioannidis dimitriou konstantinidis christodoulou antoniou stavrou",
    "kowalski nowak wojcik kowalczyk kaminski lewandowski zielinski szymanski wozniak dabrowski",
    "horvat novak kovacevic maric jovanovic petrovic nikolic markovic stojanovic ilic",
    "popescu ionescu dumitrescu stoica constantin gheorghe radu stan tudor barbu",
    "novotny svoboda dvorak cerny prochazka kucera vesely horak nemec pospisil",
    // African
    "okafor okonkwo adeyemi adebayo balogun okoye eze nwosu obi chukwu",
    "mensah owusu boateng asante appiah agyemang addo darko nkrumah amoah",
    "abdi farah hassan mohamed warsame osman jama omar ahmed nur",
    "deng ayoub garang malual majok bol wol chol lual akech",
    "tesfaye bekele girma haile mekonnen desta abebe tadesse alemu wolde",
    // East and Southeast Asian
    "tanaka suzuki sato takahashi watanabe ito yamamoto nakamura kobayashi saito",
    "kim park choi jung kang cho yoon jang lim han",
    "wongsawat chaiyaporn siriwan thongchai boonmee ratanakul srisuk pongpan chaisai kittikun",
    "santoso wijaya hartono kusuma setiawan halim gunawan tanuwijaya suryadi lesmana",
    "abdullah rahman ismail yusof hashim ibrahim othman salleh omar bakar",
    // Vietnamese
    "nguyen tran le pham hoang phan vu dang bui do",
    "ho ngo duong ly truong dinh vo mai lam ta",
    // Filipino
    "santos reyes cruz bautista ocampo garcia mendoza torres flores ramos",
    "aquino magsaysay villanueva delacruz dimaculangan pangilinan macapagal sarmiento angeles bagatsing",
    // Latin American and Iberian
    "garcia rodriguez martinez lopez gonzalez perez sanchez ramirez torres flores",
    "rivera gomez diaz cruz morales ortiz gutierrez chavez ramos herrera",
    "silva santos oliveira souza pereira costa carvalho almeida ferreira rodrigues",
    // Pacific Islander and Māori
    "tuilagi fifita taufa vaka latu kaufusi finau tupou havili moala",
    "ngata rewi tainui waititi ngatai hohepa kereopa paora rangi wiremu",
    // Dutch, German, Scandinavian
    "jansen devries bakker visser smit meijer mulder bos vos peters",
    "muller schmidt schneider fischer weber meyer wagner becker hoffmann schulz",
    "andersen jensen nielsen hansen pedersen larsen sorensen rasmussen johansson lindberg",
  ].join(" ");

  const toSet = (s) => new Set(s.split(/\s+/).filter(Boolean));

  window.GuardAI = window.GuardAI || {};
  const firstMale = toSet(FIRST_MALE);
  const firstFemale = toSet(FIRST_FEMALE);
  const firstUnisex = toSet(FIRST_UNISEX);

  window.GuardAI.NAME_GAZETTEER = {
    firstMale,
    firstFemale,
    firstUnisex,
    first: new Set([...firstMale, ...firstFemale, ...firstUnisex]),
    last: toSet(LAST),
    /**
     * Both are lowercase; callers must lowercase before lookup. A name
     * missing from either set means only "not vouched for", never "not a
     * name" — see the header.
     */
    isFirst(w) { return this.first.has(String(w).toLowerCase()); },
    /**
     * "m" | "f" | "u" | null. "u" and null are treated identically by the
     * masker (both take a neutral stand-in); they are kept distinct only so
     * callers can tell "known to be unisex" from "not in the list".
     */
    genderOf(w) {
      const k = String(w).toLowerCase();
      if (firstMale.has(k)) return "m";
      if (firstFemale.has(k)) return "f";
      if (firstUnisex.has(k)) return "u";
      return null;
    },
    isLast(w) { return this.last.has(String(w).toLowerCase()); },
  };
})();
