/**
 * Guard4AI — names-gazetteer.js
 * ---------------------------------------------------------------------------
 * Given names and surnames used ONLY by the opt-in "Aggressive name detection"
 * mode. The default rule (a full name alongside other PII) is shape-based and
 * does not consult this file at all.
 *
 * ═══ WHAT THIS LIST ACTUALLY IS ═══════════════════════════════════════════
 *
 * HAND-BUILT. NOT FREQUENCY-RANKED. NO LONGER QUOTA-CAPPED.
 *
 * There is no census extract, no name-frequency dataset and no licensed
 * corpus behind this file. It was originally written to deliberate
 * per-origin quotas reflecting Australian demographics, because an unguided
 * list skews heavily Anglo — and in this detector a missing given name is
 * not a neutral gap: an ambiguous first name only escapes the stoplist when
 * the list vouches for it, so under-covering a community means
 * systematically weaker protection for the people in it.
 *
 * ═══ WHY THE QUOTA WAS DROPPED (2026-08-29) ══════════════════════════════
 *
 * The quota was measuring the wrong thing, and it produced the very gap it
 * existed to prevent — in the group it was capping.
 *
 * Measured against 100 constructed full names across ten origin groups,
 * scoring whether EITHER token was vouched for:
 *
 *     Anglo-Celtic          5/10   <- the WORST covered group in the list
 *     African               7/10
 *     Aboriginal & TSI      6/10
 *     Indian / Greek-Italian / Pacific / Filipino   9/10
 *     Chinese / Vietnamese / Arabic-Turkish        10/10
 *
 * And 13 of the 40 most ordinary Australian given names were absent: Mia,
 * Ava, Lucas, Harrison, Matilda, Cooper, Evie, Willow, Mason, Harper, Riley,
 * Sienna, Xavier.
 *
 * The cause is arithmetic, not intent. Capping Anglo-Celtic at ~32% of 927
 * names gave it ~300 entries to cover a very large, variant-heavy space
 * (Diane/Dianne/Dianna, Megan/Meghan/Meagan, plus every short modern name),
 * while Chinese and Vietnamese given names are a smaller, more concentrated
 * space that 9% covers well. A percentage target rewards balance between
 * groups; what protects people is coverage of the names they actually have.
 *
 * So the rule now is COVERAGE, not composition. Names were added to the
 * thinnest bucket (927 -> 1,279 given names) without regard to what that
 * does to the percentages. Nothing was removed from any other group, and the
 * original reasoning still stands where it matters: do not let this list
 * drift back into being predominantly Anglo by only ever topping up the
 * group whose gaps are easiest to notice. If a non-Anglo group is measured
 * thin, top it up too.
 *
 * Consequences to keep in mind:
 *   - Ordering WITHIN each group is not frequency-ranked. Coverage of the
 *     long tail is unmeasured and certainly patchy.
 *   - Absence proves nothing. A name missing here is an artefact of how the
 *     list was written, never evidence that it isn't a real name.
 *   - Replacing this with a real frequency-ranked dataset would be a
 *     straight improvement. It was not done because that is a licensing
 *     decision, not a technical one. Topping up a thin bucket by hand, as
 *     above, is NOT that decision and does not need it.
 *   - Variants are their own entries. "Diane" does not vouch for "Dianne",
 *     and that single missing spelling is what dropped a real signature
 *     block on a live document.
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
    "aarav aaron abdirahman abebe adam adebayo aditya adrian agus ahmad ahmed",
    "aidan aiden ajay akash akira akol alan albert alejandro alessandro",
    "alexander alexandru alfie ali alistair amir amit andre andrei andrew",
    "angelo angus anil ankit anthony antonio arash archie arjun arnel arthit",
    "arthur arun athanasios aziz babak babatunde bala baljit bao baris barry",
    "beau benicio benjamin bernard bilal billy blake bodhi bogdan bol bradley",
    "brandon brayden brendan brett brian brody bruce bruno bryan bryce budi",
    "burak caleb callum calum carl carlo carlos carter cem chalermchai chamara",
    "charles chidi chinedu christian christopher christos cian clinton cody",
    "cole colin connor conor cooper cormac craig cristian curtis damian damien",
    "daniel darren darryl david davide declan deepak deng dennis derek desmond",
    "dexter diego dilshan dimitrios dinesh dominic donald dorje douglas doyoon",
    "dragan duc duncan dustin dylan edgardo eduardo edward elijah elliot emeka",
    "emiliano emre eoin eric ernest ethan euan evan ewan farhad farhan federico",
    "felix ferdinand fergus fernando filipe finlay finn fletcher florin flynn",
    "francesco freddie gabriel ganesh garang gareth gary gaurav gavin geoffrey",
    "george georgios gerald gerard getachew gheorghe giovanni giuseppe glenn",
    "gopal gordon graeme graham grant gregor gregory grzegorz guled guoqiang",
    "gurpreet gus habib hafiz hamish harold harpreet harrison harry harsh",
    "haruto harvey hassan hayden hemi henry hieu hiroshi hossein howard hudson",
    "hugh hugo hussein hyunwoo ian ibrahim ignacio ikenna imran ioannis isaac",
    "isaiah ismail ivan jack jacob jakub james jamil jared jarrod jason jasper",
    "jaspreet javier jaxon jayden jeffrey jeremy jerome jerry jett jiahao",
    "jianguo jianhua joaquin joe joel john johnathan jomar jonah jonathan jorge",
    "jose joseph joshua josip julian justin kane karan karim karthik kasun",
    "keith kelvin kenji kenneth kerem ketut keung khalid kieran koby kofi",
    "konstantinos kourosh krishna krzysztof kurt kwabena kwame kwok kyle lachie",
    "lachlan lakmal lance larry laurence lawrence leo leonard levi liam logan",
    "long lorenzo louis lucas luigi luis luka lukasz luke lyndon made mahesh",
    "mahmoud majok malcolm manish manpreet mansour marcin marco marcus marko",
    "martin mason mateo mateusz mathew matiu matteo matthew maurice max mehdi",
    "mehmet michael michal miguel mihai milan minjun mitchell mohammed mohan",
    "mohit muhammad mukesh mulugeta murali murat murray mustafa nabil najib",
    "nasir nate nathan nattapong naveen ned neil nicholas nicolas nigel nikhil",
    "nikola nikolaos nitin nnamdi noah norman nuwan nyoman obinna oisin oliver",
    "olumide omar oscar oswald owen padraig panagiotis pankaj patrick paul",
    "pawel payam pemba perry petar peter phillip phuc pietro piotr prakash",
    "praveen quan quentin rafael rahim rahul rajan rajesh raman ramesh ramon",
    "rashid ravi raymond razvan reece reid reynaldo reza rhys ricardo riccardo",
    "richard robert rodel roderick rodney roger rohan rohit roland rolando",
    "romeo ronald ronan rory ross rowan roy rupert russell ruwan ryan sachin",
    "salman salvatore sameer sami samuel sanjay santiago scott seamus sean",
    "sebastian senthil seojun serkan seth shahrul shane shaun siale siavash",
    "sicheng sidney simon simone sione somchai somsak son sota spencer stanley",
    "stavros stefan stefano stephen steven stewart struan stuart suchart",
    "sukhwinder sumit sungmin sunil suresh syafiq tadesse tahir tak takeshi",
    "tama tane tariq tarun tate tenzin terence terry tevita theo theodore",
    "thiago thomas thon timothy tobias toby todd tolga tomasz travis trent",
    "trevor troy tyler tyson varun vasile vasilios vaughan vihaan vijay vikas",
    "viliami vincent vincenzo wah wahid waleed warsame wayan wayne wenjun",
    "wesley wilfred wilfredo william wiremu xavier yash yaw yohannes youssef",
    "yusuf zac zach zachary zane zhihua zhiqiang zoran zubin zulkifli",
  ].join(" ");

  const FIRST_FEMALE = [
    "abena abigail achol adaeze addison aditi afia agnieszka aisha akosua",
    "alessia alexis alice aluel ama amaka amanda amber amelia amina amira",
    "amirah amrit amy ana anahera ananya anastasia andrea angela angelica",
    "angeliki anita anjali anna annabel annabelle annette aoi aoife aria aroha",
    "asha audrey ava ayaan ayse azadeh barbara bella bernadette bethany",
    "bethlehem betty beverly bianca bonnie brenda bridget bridgette bridie",
    "brittany caitlin camila carly carmen carol carolyn cassandra catherine",
    "catriona ceren charlotte cheryl chiamaka chiara chloe christina christine",
    "ciara claire clara claudia colleen consuelo corazon cristina cynthia dalia",
    "daniela danielle deanne deborah debra delilah denise despina dewi diane",
    "dianna dianne dilara dimitra divina divya dolores donna dorothy dragana",
    "eilidh eleanor elena eleni elif elise eliza elizabeth ella ellie elsie",
    "emily emma erin esi esperanza esra esther eunji eva evelyn evie ewa fang",
    "farhia farida faridah fatima fatma fiona folake francesca freya gabriela",
    "gabrielle gail gemma georgia georgina geraldine gillian gina gita giulia",
    "gloria golnaz grace hailey hala hallie hanna hannah harper harriet haylee",
    "hayley heather heidi helen hilary hine hodan holly hong huda huong ifeoma",
    "iman imelda imogen imogene indie inmaculada isabel isabella isabelle isha",
    "ishara isla ivana jacqueline jane janet janice janine jasmine jeanette",
    "jelena jemima jenna jennifer jennylyn jessica jessie jihye jillian joan",
    "joanna joanne jodie josephine josie joyce judith judy julia julie juliet",
    "jyoti kaitlyn kanya karen katarzyna kate katelyn katerina katherine",
    "kathleen kathryn kavita kavya keira kiera kimberly kiri kirsty kristen",
    "kylie lakshmi laleh lan lara laura lauren layla leah leanne leila lena",
    "lhamo liadh lila linda ling lisa lola lori lorraine louise lourdes lucia",
    "lucy luna lupe lynette maddison madison maeve magdalena maggie mai mairi",
    "mala malak malgorzata malia manaia mandy margaret margot maria mariana",
    "marie marija marilyn marion marnie martha martina mary maryam matilda",
    "maureen meagan megan megha meghan mei melanie melissa mercedes mere merve",
    "meseret mia michelle mila minseo mirjana mitra monica montserrat nadeesha",
    "nadia nadine namrata nancy nasra nasrin natalia natalie natasa navjot neha",
    "ngoc ngozi nhung niamh nicole nina noor nora nurul nyandeng ofa olivia",
    "orla pamela parisa parvati patricia paula phoebe pilar pinar piper pooja",
    "poppy pornthip preeti priya putri qin rachael rachel radha rania rebecca",
    "rekha renee rhonda rina ritu riya robyn rocio roisin rosario rose rosemary",
    "rosie rosnah roya ruby rupinder ruth sabrina sadie sakura salma samantha",
    "samira sanaz sandra sanduni sanja saoirse sara sarah saraswati scarlett",
    "selamawit selin shalini sharon sheree shirin shirley shreya sienna silvia",
    "simran sina sinead siobhan siriporn sita sneha snezana sofia soledad",
    "sophia sophie soyeon sri stella stephanie sunita susan suzanne swati",
    "tahlia tania tanya teresa thao thea theresa therese thilini tigist tilly",
    "tracey trang tricia tupou usha vaea valentina vanessa vasiliki veronica",
    "vesna vicki victoria violet virginia wanida wendy willow xia yasmin",
    "yewande yui yun yvonne zahra zainab zara zeynep zhen zoe zoey zofia",
  ].join(" ");

  const FIRST_UNISEX = [
    "adelaide ajak alex alexandria alinta allira angel anh april ariki art",
    "ashleigh ashley ashton august austin autumn avery bailey bill billie bin",
    "bindi birrani bobbie brook brooke brooklyn buck bud cameron carey carolina",
    "casey charlie chase chau chelsea chen chi ching chip chris chun clay",
    "cleveland cliff colt courtney crystal daisy dakota dale dana darcy dawa",
    "dawn dean devon drew duke dung earl eden ellis emerson eumarrah faith",
    "farah feng finley florence ford frank frankie fung gang gene gerry giang",
    "glen guy hamilton hanh haoyu harley harmony hazel heath hei hoang hoi hope",
    "hua hui hunter india iris ivy jackson jade jaime jamie jarrah jayme jedda",
    "jess jesse jie jing jiwoo jo jody jordan joy juan jules jun june justice",
    "ka kai kalinda karma kauri kayla kelechi kelly kendall kent kerry khanh",
    "khoa king kingston kiran kirra kirrily kit koori lagi lane lee lei leigh",
    "leslie li lily lincoln lindsay linh lok lou lowanna mackenzie man mark",
    "marley may mckenzie melody miles miminy ming minh moana montana morgan",
    "moss nana narelle ngaio nguyen nicky nima noel olive oluwaseun paris",
    "pasang pat pearl penny peyton phoenix phuong ping prince qiang quinn quyen",
    "rain rangi ray reed reese rich richmond riley rob robbie robin royal ruoxi",
    "sage sam sandy savannah serenity shannon shea shun sierra siu sky skye",
    "skyler sonam star stevie storm summer sunny sydney tafili talia tao tarni",
    "tashi taylor temitope thanh tianyi tran trinity tuan uchenna val van wade",
    "walter wandjina warrin waru washington wei will wing wren xiaohong xiaoli",
    "xiaoming xin yan yang yee yichen yindi yiran yu yuen yuhan yuki yuxuan",
    "zixuan ziyi",
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
