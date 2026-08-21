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

  // ---- Given names --------------------------------------------------------
  const FIRST = [
    // Anglo-Celtic
    "james john robert michael william david richard joseph thomas charles",
    "christopher daniel matthew anthony donald mark paul steven andrew kenneth",
    "george edward brian ronald timothy jason jeffrey ryan jacob gary",
    "nicholas eric stephen jonathan larry justin scott brandon benjamin samuel",
    "gregory alexander patrick jack dennis jerry tyler aaron jose adam",
    "nathan henry douglas zachary peter kyle ethan walter noah jeremy",
    "christian keith roger terry gerald harold sean austin carl arthur",
    "lawrence dylan jesse jordan bryan billy joe bruce gabriel logan",
    "mary patricia jennifer linda elizabeth barbara susan jessica sarah karen",
    "nancy lisa margaret betty sandra ashley dorothy kimberly emily donna",
    "michelle carol amanda melissa deborah stephanie rebecca sharon laura cynthia",
    "kathleen amy angela shirley anna brenda pamela emma nicole helen",
    "samantha katherine christine debra rachel carolyn janet catherine maria heather",
    "diane ruth julie olivia joyce virginia victoria kelly lauren christina joan",
    "evelyn judith megan andrea cheryl hannah jacqueline martha gloria teresa",
    "sara janice marie julia kathryn grace judy theresa madison beverly",
    "denise marilyn amber danielle abigail brittany rose natalie sophia alexis",
    "lori kayla jane charlotte chloe zoe sophie isla amelia poppy",
    "liam oliver harry archie leo freddie alfie theo finlay callum",
    "siobhan aoife niamh saoirse ciara eoin cian oisin declan fergus",
    "bridget maeve roisin sinead orla padraig seamus liadh cormac ronan",
    "angus hamish fiona isla mairi eilidh calum struan lachlan rory",
    // Chinese (pinyin and Cantonese romanisations)
    "wei ming chen jun hui feng lei yang tao bin",
    "jing yan hua ping li qiang gang jie xin yu",
    "xiaoming xiaohong xiaoli jianguo jianhua guoqiang zhiqiang zhihua yuxuan zixuan",
    "mei ling fang juan xia yun lan zhen qin hong",
    "siu wing kwok chun yuen hoi keung shun tak wah",
    "ka man yee ling chi kit fung hei lok ching",
    "haoyu yichen ziyi yiran ruoxi jiahao yuhan sicheng tianyi wenjun",
    // Indian subcontinent
    "priya ananya aarav vihaan arjun aditya rohan rahul ravi anil",
    "sunil vijay ajay sanjay rajesh mahesh suresh ramesh dinesh mukesh",
    "amit sumit rohit mohit ankit nikhil akash vikas manish gaurav",
    "deepak pankaj kiran karan varun tarun harsh yash krishna gopal",
    "kavya divya shreya pooja neha sneha riya isha aditi anjali",
    "swati preeti jyoti kavita sunita anita namrata shalini megha ritu",
    "rajan naveen praveen sachin nitin sameer zubin farhan imran salman",
    "arun bala murali senthil karthik prakash suresh ganesh mohan raman",
    "lakshmi saraswati parvati radha sita gita usha rekha asha mala",
    "gurpreet harpreet manpreet jaspreet amrit simran navjot rupinder baljit sukhwinder",
    "tenzin pemba dorje karma sonam nima pasang lhamo dawa tashi",
    "kasun nuwan chamara dilshan sanduni ishara thilini nadeesha lakmal ruwan",
    // Arabic, Turkish, Persian, Afghan
    "mohammed muhammad ahmed ahmad ali omar hassan hussein khalid ibrahim",
    "yusuf youssef mustafa mahmoud tariq bilal rashid sami karim nabil",
    "fatima aisha layla zainab maryam noor huda amira salma rania",
    "yasmin dalia hala nadia samira leila farida iman sabrina malak",
    "mehmet mustafa emre burak serkan kerem baris cem murat tolga",
    "elif zeynep merve ayse fatma esra selin ceren dilara pinar",
    "reza mehdi hossein amir kourosh farhad babak arash siavash payam",
    "shirin parisa maryam nasrin laleh mitra golnaz roya azadeh sanaz",
    "wahid najib zahra rahim habib mansour jamil nasir tahir waleed",
    // Southern and Eastern European
    "giuseppe giovanni antonio francesco luigi angelo vincenzo pietro salvatore carlo",
    "marco andrea alessandro matteo lorenzo davide simone federico stefano riccardo",
    "maria giulia francesca chiara sara valentina martina alessia elena silvia",
    "dimitrios georgios ioannis konstantinos nikolaos panagiotis christos vasilios athanasios stavros",
    "eleni maria katerina sofia despina vasiliki angeliki georgia dimitra anastasia",
    "piotr pawel jakub lukasz mateusz krzysztof marcin tomasz michal grzegorz",
    "anna katarzyna malgorzata agnieszka barbara ewa magdalena joanna zofia natalia",
    "ivan marko luka petar nikola stefan milan dragan zoran josip",
    "ana ivana marija jelena snezana vesna dragana mirjana natasa sanja",
    "andrei mihai stefan cristian gheorghe alexandru vasile florin bogdan razvan",
    // African (Nigerian, Ghanaian, Somali, Sudanese, Ethiopian, Eritrean)
    "chidi ngozi adebayo temitope olumide chinedu emeka ifeoma amaka obinna",
    "yewande folake babatunde oluwaseun chiamaka nnamdi uchenna adaeze kelechi ikenna",
    "kwame kofi kwabena yaw abena akosua ama afia esi nana",
    "abdirahman hodan ayaan farhia guled ismail hassan warsame nasra amina",
    "deng akol garang nyandeng ajak majok aluel achol bol thon",
    "abebe tadesse getachew mulugeta selamawit hanna bethlehem meseret tigist yohannes",
    // East and Southeast Asian
    "hiroshi yuki sakura takeshi kenji akira haruto sota yui aoi",
    "minjun seojun doyoon jiwoo hyunwoo sungmin jihye soyeon eunji minseo",
    "somchai somsak suchart pornthip siriporn kanya arthit nattapong wanida chalermchai",
    "budi agus dewi sri putri wayan ketut made nyoman rina",
    "aziz farah hafiz nurul syafiq amirah zulkifli shahrul faridah rosnah",
    // Vietnamese
    "nguyen tran phuong linh thanh huong minh tuan hoang anh",
    "duc long quan hieu khanh trang mai lan ngoc thao",
    "bao chau dung giang hanh khoa nhung phuc quyen son",
    // Filipino
    "jose maria juan antonio ramon carlo miguel angelo joshua mark",
    "rosario cristina angelica jennylyn jasmine grace divina imelda corazon lourdes",
    "reynaldo rodel jomar dexter arnel wilfredo ferdinand romeo rolando edgardo",
    // Latin American and Iberian
    "carlos luis jorge fernando ricardo eduardo alejandro javier diego rafael",
    "mateo santiago sebastian nicolas emiliano thiago benicio joaquin ignacio bruno",
    "valentina isabella sofia camila lucia mariana gabriela daniela paula andrea",
    "carmen pilar rocio inmaculada montserrat esperanza consuelo dolores mercedes soledad",
    // Pacific Islander and Māori
    "sione viliami tevita filipe manaia moana anahera aroha kiri hine",
    "tama rangi kauri matiu wiremu tane ariki mere ngaio hemi",
    "sina lupe tafili malia siale ofa lagi tupou vaea tevita",
    // Aboriginal and Torres Strait Islander
    "jedda kirra lowanna alinta warrin jarrah kirrily narelle koori yindi",
    "birrani miminy tarni waru wandjina bindi allira eumarrah kalinda talia",
    // AMBIGUOUS given names — words that are also ordinary nouns, months or
    // places. They belong here because they ARE real given names; the
    // detector cross-references them against its own AMBIGUOUS_FIRST set and
    // demands a second signal before flagging. Leaving them out instead would
    // not make the detector safer, it would just make that whole tier dead
    // code: a word absent from this list is never a candidate at all.
    // Deliberately excluded: place names that are not plausibly given names
    // (Perth, Houston, Dallas, Memphis, Cairo, Kenya, Cyprus).
    "hope faith joy lily daisy pearl ruby crystal summer autumn",
    "dawn sky star angel art bill will rob chase drew",
    "miles reed wade hunter frank earl rich buck dale glen",
    "cliff brook brooke heath ford rain storm sunny guy van",
    "gene bud chip penny hazel olive ivy iris jade sage",
    "clay colt dean kent lane moss trinity melody harmony serenity",
    "justice royal king prince duke april may june august noel",
    "sydney adelaide florence paris phoenix india jackson lincoln washington brooklyn",
    "chelsea kingston richmond hamilton cleveland carolina dakota montana savannah sierra",
    "eden alexandria",
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
  window.GuardAI.NAME_GAZETTEER = {
    first: toSet(FIRST),
    last: toSet(LAST),
    /**
     * Both are lowercase; callers must lowercase before lookup. A name
     * missing from either set means only "not vouched for", never "not a
     * name" — see the header.
     */
    isFirst(w) { return this.first.has(String(w).toLowerCase()); },
    isLast(w) { return this.last.has(String(w).toLowerCase()); },
  };
})();
