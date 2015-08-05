var gulp = require('gulp');
// var uglify = require('gulp-uglify');

gulp.task('scripts', function() {
  // Minify and copy all JavaScript (except vendor scripts)
  gulp.src(['client/js/**/*.js', '!client/js/vendor/**'])
    .pipe(uglify())
    .pipe(gulp.dest('build/js'));

  // Copy vendor files
  gulp.src('client/js/vendor/**')
    .pipe(gulp.dest('build/js/vendor'));
});

var kendoUI = 'jspm_packages/github/kendo-labs/bower-kendo-ui@2015.2.727',
    bootstrap = 'jspm_packages/github/twbs/bootstrap@3.3.5',
    fontAwesome = 'jspm_packages/npm/font-awesome@4.3.0';

// Copy all static assets
gulp.task('copy', function() {

  // Kendo UI
  gulp.src([kendoUI + '/styles/kendo.common-bootstrap.min.css', 
            kendoUI + '/styles/kendo.silver.min.css', 
            kendoUI + '/styles/kendo.silver.mobile.min.css'])
    .pipe(gulp.dest('css/kendo'));

  gulp.src(kendoUI + '/styles/textures/**/*')
    .pipe(gulp.dest('css/kendo/textures'));

  gulp.src(kendoUI + '/styles/Silver/**/*')
    .pipe(gulp.dest('css/kendo/Silver'));

  gulp.src(kendoUI + '/styles/fonts/**/*')
    .pipe(gulp.dest('css/kendo/fonts'));

  gulp.src(kendoUI + '/styles/images/**/*')
    .pipe(gulp.dest('css/kendo/images'));

  // Bootstrap
  gulp.src(bootstrap + '/css/bootstrap.min.css')
    .pipe(gulp.dest('css/bootstrap'));

  // Font Awesome
  gulp.src(fontAwesome + '/css/font-awesome.min.css')
    .pipe(gulp.dest('css/font-awesome/css'));

  gulp.src(fontAwesome + '/fonts/**/*')
    .pipe(gulp.dest('css/font-awesome/fonts'));

  // gulp.src('client/css/**')
  //   .pipe(gulp.dest('build/css'));

  // gulp.src('client/*.html')
  //   .pipe(gulp.dest('build'));
});

// The default task (called when you run `gulp`)
gulp.task('default', function() {
  gulp.run('copy');

  // Watch files and run tasks if they change
  // gulp.watch('client/js/**', function(event) {
  //   gulp.run('scripts');
  // });

  // gulp.watch([
  //   'client/img/**',
  //   'client/css/**',
  //   'client/*.html'
  // ], function(event) {
  //   gulp.run('copy');
  // });
});