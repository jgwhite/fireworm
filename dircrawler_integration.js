var DirCrawler = require('./dircrawler')

var c = new DirCrawler('./')
c.add('one/*.js')

c.crawl(function(){})

c.on('change', function(filepath){
  console.log(filepath, 'changed')
})

setInterval(function(){}, 1000)