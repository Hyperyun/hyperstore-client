module.exports = function(grunt) {
  grunt.loadNpmTasks('grunt-browserify');
  grunt.loadNpmTasks('grunt-contrib-uglify');

  // Project configuration.
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    uglify: {
      dist: {
        options: {
          banner: '/* Hyperyun Hyperstore <%= pkg.version %> */\n',
          compress: { drop_console: true },
          mangle: {toplevel: true, sort: true}
        },
        files: {
          'dist/hyperstore.min.js': ['dist/hyperstore.js']
        }
      },
      rhino: {
        options: {
          banner: '/* Hyperyun Hyperstore <%= pkg.version %> */\n',
          compress: { drop_console: true },
          mangle: {toplevel: true, sort: true}
        },
        files: {
          'rhino/hyperstore.min.js': ['rhino/hyperstore.js']
        }
      }
    },
    browserify: {
      dist: {
        files: {
          'dist/hyperstore.js': ['main.js']
        },
        options: {
          browserifyOptions: {
            fullPaths: false
          }
        }
      },
      rhino: {
        files: {
          'rhino/hyperstore.js': ['main.js']
        },
        options: {
          exclude: "socket.io-client",
          browserifyOptions: {
            fullPaths: false,
            standalone: 'Hyperyun',
          }
        }
      }
    }
  });

  grunt.task.registerTask('bump', 'Bumps version (accepts argument [patch, minor, major]).', function(update) {
    if(!update || update=="undefined" || update=="null") update = "patch";

    var pkg = grunt.file.readJSON('package.json');
    var bower = grunt.file.readJSON('bower.json');
    var versions = pkg.version.split('.');
    if(update=="patch") {
      versions[2] = parseInt(versions[2])+1;
    } else if(update=="minor") {
      versions[2] = 0;
      versions[1] = parseInt(versions[1])+1;
    } else if(update=="major") {
      versions[2] = 0;
      versions[1] = 0;
      versions[0] = parseInt(versions[0])+1;
    } else {
      grunt.fail.fatal("Invalid argument");
    }
    pkg.version = versions[0]+'.'+versions[1]+'.'+versions[2];
    bower.version = versions[0]+'.'+versions[1]+'.'+versions[2];
    grunt.file.write('package.json', JSON.stringify(pkg, null, '  ') + '\n');
    grunt.file.write('bower.json', JSON.stringify(bower, null, '  ') + '\n');

    grunt.log.ok("Bumped up the version to "+pkg.version);
  });

  grunt.registerTask('build', 'Bumps version (accepts argument [patch, minor, major]) and builds distribution files.', function(update) {
    grunt.task.run(['bump:'+update, 'dist']);
  });

  grunt.registerTask('dist', 'Builds distribution files.', ['browserify:dist', 'uglify:dist']);

  grunt.registerTask('rhino', 'Builds rhino files.', ['browserify:rhino', 'uglify:rhino']);

  grunt.registerTask('default', 'Runs build command with "patch" argument', ['build:patch']);

};
